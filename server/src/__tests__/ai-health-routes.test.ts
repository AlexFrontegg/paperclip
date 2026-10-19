import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agents, companies, companyMemberships, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

describeEmbeddedPostgres("company AI health route", () => {
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-health-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-health-routes");
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-health-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const userId = `owner-${companyId}`;
    await db.insert(companies).values([
      { id: companyId, name: "AI health", issuePrefix: `H${companyId.slice(0, 7)}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 7)}` },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const accounts = aiConnectionService(db);
    const connect = (provider: "anthropic" | "openai", name: string, apiKey: string) =>
      accounts.save(companyId, userId, { provider, method: "api_key", name, ownership: "shared", apiKey, agentIds: [], allAgents: true }, apiKey);
    const claude = await connect("anthropic", "Claude for all", "fixture-claude-secret");
    const openai = await connect("openai", "OpenAI", "fixture-openai-secret");
    const spareOpenai = await connect("openai", "Spare OpenAI", "fixture-spare-secret");
    const claudeBinding = { provider: "anthropic", method: "api_key", mode: "shared", ...claude } as const;
    const openaiBinding = { provider: "openai", method: "api_key", mode: "shared", ...openai } as const;
    const spareBinding = { provider: "openai", method: "api_key", mode: "shared", ...spareOpenai } as const;
    const fallbackTo = (aiConnection: typeof openaiBinding) => ({
      enabled: true, adapterType: "codex_local", adapterConfig: { model: "gpt-6-astra" }, aiConnection, switchWhenUnavailable: true,
    });
    const [onBackup, noAi, healthy, terminated] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(agents).values([
      { id: onBackup, companyId, name: "Forge", adapterType: "claude_local", adapterConfig: { model: "claude-opus", env: { ANTHROPIC_API_KEY: "fixture-env-secret" } }, runtimeConfig: { aiConnection: claudeBinding, usageLimitFallback: fallbackTo(openaiBinding) } },
      { id: noAi, companyId, name: "NuReview", adapterType: "claude_local", runtimeConfig: { aiConnection: claudeBinding, usageLimitFallback: fallbackTo(spareBinding) } },
      { id: healthy, companyId, name: "PR Nudge", adapterType: "codex_local", runtimeConfig: { aiConnection: openaiBinding } },
      { id: terminated, companyId, name: "Retired", adapterType: "claude_local", status: "terminated", runtimeConfig: { aiConnection: claudeBinding } },
    ]);
    const activatedAt = new Date(Date.now() - 60_000).toISOString();
    await db.insert(agentRuntimeState).values({
      agentId: onBackup, companyId, adapterType: "claude_local",
      stateJson: { usageLimitFallback: { activeUntil: new Date(Date.now() + 60_000).toISOString(), activatedAt, sourceRunId: randomUUID(), primaryAdapterType: "claude_local", fallbackAdapterType: "codex_local", reason: "primary_signed_out", waitForReconnect: true } },
    });
    await db.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign in again to restore this AI connection." }).where(eq(toolConnections.id, claude.connectionId));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, spareOpenai.grantId));
    return { companyId, otherCompanyId, userId, claude, openai, spareOpenai, onBackup, noAi, healthy, activatedAt };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", aiConnectionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("reports broken connections, agents on their fallback and agents with no working AI, without secrets", async () => {
    const f = await fixture();
    const app = appFor({ type: "board", source: "session", userId: f.userId, companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] });
    const response = await request(app).get(`/api/companies/${f.companyId}/ai-health`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const byId = (id: string) => response.body.connections.find((connection: { id: string }) => connection.id === id);
    expect(response.body.connections).toHaveLength(3);
    expect(byId(f.claude.connectionId)).toEqual({ id: f.claude.connectionId, name: "Claude for all", provider: "anthropic", status: "needs_attention", affectedAgentIds: [f.onBackup, f.noAi] });
    expect(byId(f.openai.connectionId)).toMatchObject({ status: "connected", affectedAgentIds: [f.onBackup, f.healthy] });
    expect(byId(f.spareOpenai.connectionId)).toMatchObject({ status: "revoked", affectedAgentIds: [f.noAi] });
    expect(response.body.agents).toEqual([
      {
        agentId: f.onBackup, lane: "fallback", fallbackActive: true, noWorkingAi: false, since: f.activatedAt, until: expect.any(String),
        waitForReconnect: true, reason: "primary_signed_out", suspendedReason: null,
        primaryAdapterType: "claude_local", primaryModel: "claude-opus", primaryConnectionId: f.claude.connectionId,
        fallbackAdapterType: "codex_local", fallbackModel: "gpt-6-astra", fallbackConnectionId: f.openai.connectionId,
      },
      expect.objectContaining({ agentId: f.noAi, lane: "primary", fallbackActive: false, noWorkingAi: true, primaryConnectionId: f.claude.connectionId, fallbackConnectionId: f.spareOpenai.connectionId }),
    ]);
    const body = JSON.stringify(response.body);
    for (const secret of ["fixture-claude-secret", "fixture-openai-secret", "fixture-spare-secret", "fixture-env-secret", f.claude.grantId]) {
      expect(body).not.toContain(secret);
    }
  });

  it("rejects other companies and agent callers", async () => {
    const f = await fixture();
    const board = appFor({ type: "board", source: "session", userId: f.userId, companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] });
    expect((await request(board).get(`/api/companies/${f.otherCompanyId}/ai-health`)).status).toBe(403);
    const agent = appFor({ type: "agent", agentId: f.onBackup, companyId: f.companyId, source: "agent_jwt" });
    expect((await request(agent).get(`/api/companies/${f.companyId}/ai-health`)).status).toBe(403);
  });
});
