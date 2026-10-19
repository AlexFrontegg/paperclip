import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agents, aiConnectionDefaults, aiProviderDefaults, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, toolConnections } from "@paperclipai/db";
import type { AgentAiHealth, CompanyAiHealth } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

type Account = { connectionId: string; grantId: string };
type Provider = "anthropic" | "openai";

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

  async function company() {
    const companyId = randomUUID();
    const userId = `owner-${companyId}`;
    await db.insert(companies).values({ id: companyId, name: "AI health", issuePrefix: `H${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const secrets: string[] = [];
    const grantIds: string[] = [];
    const connect = async (provider: Provider, name: string, ownership: "shared" | "personal" = "shared", ownerId = userId): Promise<Account> => {
      const apiKey = `fixture-secret-${randomUUID()}`;
      secrets.push(apiKey);
      const account = await aiConnectionService(db).save(companyId, ownerId, { provider, method: "api_key", name, ownership, apiKey, agentIds: [], allAgents: true }, apiKey);
      grantIds.push(account.grantId);
      return account;
    };
    const binding = (provider: Provider, account: Account) => ({ provider, method: "api_key", mode: "shared", ...account });
    const fallbackTo = (adapterType: "claude_local" | "codex_local", aiConnection: unknown, extra: Record<string, unknown> = {}) => ({
      enabled: true, adapterType, adapterConfig: { model: adapterType === "codex_local" ? "gpt-6-astra" : "claude-opus" }, aiConnection, switchWhenUnavailable: true, ...extra,
    });
    const addAgent = async (name: string, adapterType: "claude_local" | "codex_local", runtimeConfig: Record<string, unknown>, extra: Partial<typeof agents.$inferInsert> = {}) => {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId, name, adapterType, runtimeConfig, ...extra });
      return id;
    };
    const setFallbackState = async (agentId: string, state: Record<string, unknown>) => {
      const fallbackState = {
        activeUntil: new Date(Date.now() + 60_000).toISOString(),
        activatedAt: new Date(Date.now() - 60_000).toISOString(),
        sourceRunId: randomUUID(),
        primaryAdapterType: "claude_local",
        fallbackAdapterType: "codex_local",
        reason: "primary_signed_out",
        ...state,
      };
      await db.insert(agentRuntimeState).values({ agentId, companyId, adapterType: "claude_local", stateJson: { usageLimitFallback: fallbackState } })
        .onConflictDoUpdate({ target: agentRuntimeState.agentId, set: { stateJson: { usageLimitFallback: fallbackState } } });
      return fallbackState;
    };
    const signOut = (account: Account) => db.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign in again to restore this AI connection." }).where(eq(toolConnections.id, account.connectionId));
    const app = (viewerId = userId) => {
      const server = express();
      server.use((req, _res, next) => {
        req.actor = { type: "board", source: "session", userId: viewerId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
        next();
      });
      server.use("/api", aiConnectionRoutes(db));
      server.use(errorHandler);
      return server;
    };
    const health = async (viewerId = userId): Promise<CompanyAiHealth> => {
      const response = await request(app(viewerId)).get(`/api/companies/${companyId}/ai-health`);
      expect(response.status).toBe(200);
      return response.body;
    };
    const agentHealth = (body: CompanyAiHealth, agentId: string): AgentAiHealth | undefined => body.agents.find((agent) => agent.agentId === agentId);
    return { companyId, userId, secrets, grantIds, connect, binding, fallbackTo, addAgent, setFallbackState, signOut, app, health, agentHealth };
  }

  it("reports broken accounts, agents on their fallback, with no working AI or a broken backup, without secrets", async () => {
    const c = await company();
    const claude = await c.connect("anthropic", "Claude for all");
    const openai = await c.connect("openai", "OpenAI");
    const spare = await c.connect("openai", "Spare OpenAI");
    const claudeBinding = c.binding("anthropic", claude);
    const forge = await c.addAgent("Forge", "claude_local", { aiConnection: claudeBinding, usageLimitFallback: c.fallbackTo("codex_local", c.binding("openai", openai)) }, { adapterConfig: { model: "claude-opus", env: { ANTHROPIC_API_KEY: "fixture-env-secret" } } });
    const lizzy = await c.addAgent("Lizzy", "codex_local", { aiConnection: c.binding("openai", openai), usageLimitFallback: c.fallbackTo("claude_local", claudeBinding) });
    const nuReview = await c.addAgent("NuReview", "claude_local", { aiConnection: claudeBinding, usageLimitFallback: c.fallbackTo("codex_local", c.binding("openai", spare)) });
    const prNudge = await c.addAgent("PR Nudge", "codex_local", { aiConnection: c.binding("openai", openai) });
    await c.addAgent("Retired", "claude_local", { aiConnection: claudeBinding }, { status: "terminated" });
    const state = await c.setFallbackState(forge, { waitForReconnect: true, activeUntil: new Date(Date.now() - 1_000).toISOString() });
    await c.signOut(claude);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, spare.grantId));

    const response = await request(c.app()).get(`/api/companies/${c.companyId}/ai-health`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body: CompanyAiHealth = response.body;
    const account = (key: string | null | undefined) => body.connections.find((entry) => entry.key === key);
    expect(body.connections.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "Claude for all", status: "needs_attention" },
      { name: "OpenAI", status: "connected" },
      { name: "Spare OpenAI", status: "revoked" },
    ]);
    expect(account(c.agentHealth(body, forge)?.primaryConnectionKey)).toMatchObject({ id: claude.connectionId, provider: "anthropic" });
    expect(body.agents.map((agent) => agent.agentId)).toEqual([forge, lizzy, nuReview]);
    expect(c.agentHealth(body, prNudge)).toBeUndefined();
    // A signed-out primary keeps the fallback past its window, as a run claim would.
    expect(c.agentHealth(body, forge)).toEqual({
      agentId: forge, lane: "fallback", fallbackActive: true, noWorkingAi: false, backupIssue: null,
      since: state.activatedAt, until: expect.any(String), waitForReconnect: true, reason: "primary_signed_out", suspendedReason: null,
      primaryAdapterType: "claude_local", primaryModel: "claude-opus", primaryConnectionKey: expect.any(String),
      fallbackAdapterType: "codex_local", fallbackModel: "gpt-6-astra", fallbackConnectionKey: expect.any(String),
    });
    expect(Date.parse(c.agentHealth(body, forge)!.until!)).toBeGreaterThan(Date.now());
    expect(c.agentHealth(body, lizzy)).toMatchObject({ lane: "primary", fallbackActive: false, noWorkingAi: false, backupIssue: "account" });
    expect(account(c.agentHealth(body, lizzy)?.fallbackConnectionKey)?.name).toBe("Claude for all");
    expect(c.agentHealth(body, nuReview)).toMatchObject({ lane: "primary", fallbackActive: false, noWorkingAi: true, backupIssue: "account" });

    const serialized = JSON.stringify(body);
    for (const secret of [...c.secrets, ...c.grantIds, "fixture-env-secret"]) expect(serialized).not.toContain(secret);
  });

  it("reports No AI when the fallback hit its own usage limit, until a fallback run succeeds", async () => {
    const c = await company();
    const claude = await c.connect("anthropic", "Claude for all");
    const openai = await c.connect("openai", "OpenAI");
    const forge = await c.addAgent("Forge", "claude_local", { aiConnection: c.binding("anthropic", claude), usageLimitFallback: c.fallbackTo("codex_local", c.binding("openai", openai)) });
    await c.setFallbackState(forge, { waitForReconnect: true });
    await c.signOut(claude);
    const fallbackRun = (finishedAt: Date, failure: Partial<typeof heartbeatRuns.$inferInsert>) => db.insert(heartbeatRuns).values({
      companyId: c.companyId, agentId: forge, startedAt: new Date(finishedAt.getTime() - 1_000), finishedAt, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", lane: "fallback" } }, ...failure,
    });
    await fallbackRun(new Date(Date.now() - 5 * 60_000), { status: "failed", errorCode: "provider_quota" });
    await fallbackRun(new Date(Date.now() - 30_000), { status: "failed", errorCode: "acpx_turn_failed", resultJson: { errorFamily: "provider_quota" } });
    expect(c.agentHealth(await c.health(), forge)).toMatchObject({ lane: "fallback", noWorkingAi: true, backupIssue: "usage_limit" });

    await fallbackRun(new Date(), { status: "succeeded" });
    expect(c.agentHealth(await c.health(), forge)).toMatchObject({ lane: "fallback", noWorkingAi: false, backupIssue: null });
  });

  it("ignores a saved fallback that a run claim would clear", async () => {
    const c = await company();
    const claude = await c.connect("anthropic", "Claude for all");
    const openai = await c.connect("openai", "OpenAI");
    const fallback = c.fallbackTo("codex_local", c.binding("openai", openai));
    const disabled = await c.addAgent("Disabled", "claude_local", { aiConnection: c.binding("anthropic", claude), usageLimitFallback: { ...fallback, enabled: false } });
    const reconnected = await c.addAgent("Reconnected", "claude_local", { aiConnection: c.binding("anthropic", claude), usageLimitFallback: fallback });
    const outageNotAllowed = await c.addAgent("Outage", "claude_local", { aiConnection: c.binding("anthropic", claude), usageLimitFallback: { ...fallback, switchWhenUnavailable: false } });
    const movedPrimary = await c.addAgent("Moved", "codex_local", { aiConnection: c.binding("openai", openai), usageLimitFallback: c.fallbackTo("claude_local", c.binding("anthropic", claude)) });
    for (const agentId of [disabled, reconnected, movedPrimary]) await c.setFallbackState(agentId, { waitForReconnect: true });
    await c.setFallbackState(outageNotAllowed, { reason: "provider_outage" });

    const body = await c.health();
    expect(body.agents).toEqual([]);
  });

  it("reports No AI when a usage-limit fallback cannot use its broken backup account", async () => {
    const c = await company();
    const claude = await c.connect("anthropic", "Claude for all");
    const openai = await c.connect("openai", "OpenAI");
    const forge = await c.addAgent("Forge", "claude_local", { aiConnection: c.binding("anthropic", claude), usageLimitFallback: c.fallbackTo("codex_local", c.binding("openai", openai)) });
    await c.setFallbackState(forge, { reason: "provider_quota" });
    await c.signOut(openai);
    expect(c.agentHealth(await c.health(), forge)).toMatchObject({ lane: "primary", fallbackActive: true, noWorkingAi: true, backupIssue: "account", reason: "provider_quota" });
  });

  it("treats deleted accounts and accounts whose owner left as broken, and hides names the viewer cannot use", async () => {
    const c = await company();
    const colleague = `colleague-${c.companyId}`;
    await db.insert(companyMemberships).values({ companyId: c.companyId, principalType: "user", principalId: colleague, membershipRole: "member", status: "active" });
    const personal = await c.connect("anthropic", "Colleague's Claude", "personal", colleague);
    const deleted = { connectionId: randomUUID(), grantId: randomUUID() };
    const onDeleted = await c.addAgent("Deleted", "claude_local", { aiConnection: c.binding("anthropic", deleted) });
    const onPersonal = await c.addAgent("Personal", "claude_local", { aiConnection: { ...c.binding("anthropic", personal), mode: "delegated" } });

    let body = await c.health();
    const account = (key: string | null | undefined) => body.connections.find((entry) => entry.key === key);
    expect(account(c.agentHealth(body, onDeleted)?.primaryConnectionKey)).toMatchObject({ id: deleted.connectionId, name: null, status: "missing" });
    expect(c.agentHealth(body, onDeleted)).toMatchObject({ noWorkingAi: true, backupIssue: "not_configured" });
    expect(c.agentHealth(body, onPersonal)).toBeUndefined();
    expect(body.connections.find((entry) => entry.id === personal.connectionId)).toMatchObject({ name: null, status: "connected" });
    expect((await c.health(colleague)).connections.find((entry) => entry.id === personal.connectionId)?.name).toBe("Colleague's Claude");

    await db.update(companyMemberships).set({ status: "suspended" }).where(and(eq(companyMemberships.companyId, c.companyId), eq(companyMemberships.principalId, colleague)));
    body = await c.health();
    expect(body.connections.find((entry) => entry.id === personal.connectionId)).toMatchObject({ status: "needs_attention" });
    expect(c.agentHealth(body, onPersonal)).toMatchObject({ noWorkingAi: true });

    await db.delete(aiConnectionDefaults).where(eq(aiConnectionDefaults.grantId, personal.grantId));
    await db.delete(aiProviderDefaults).where(eq(aiProviderDefaults.grantId, personal.grantId));
    await db.delete(connectionGrants).where(eq(connectionGrants.id, personal.grantId));
    body = await c.health();
    expect(body.connections.find((entry) => entry.id === personal.connectionId)).toMatchObject({ status: "missing" });
  });

  it("rejects other companies and agent callers", async () => {
    const c = await company();
    const other = await company();
    expect((await request(c.app()).get(`/api/companies/${other.companyId}/ai-health`)).status).toBe(403);
    const agentId = await c.addAgent("Forge", "claude_local", {});
    const server = express();
    server.use((req, _res, next) => { req.actor = { type: "agent", agentId, companyId: c.companyId, source: "agent_jwt" }; next(); });
    server.use("/api", aiConnectionRoutes(db));
    server.use(errorHandler);
    expect((await request(server).get(`/api/companies/${c.companyId}/ai-health`)).status).toBe(403);
  });
});
