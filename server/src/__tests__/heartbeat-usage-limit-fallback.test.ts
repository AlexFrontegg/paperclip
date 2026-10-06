import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agentTaskSessions, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  activateUsageLimitFallback,
  clearUsageLimitFallbackState,
  effectiveAgentForRun,
  readAgentUsageLimitFallbackState,
  resolveAdapterDispatchForClaim,
} from "../services/usage-limit-fallback.ts";

vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const RESET_AT = "2030-04-22T21:00:00.000Z";
const codexFallback = { enabled: true, adapterType: "codex_local", adapterConfig: { model: "gpt-fallback-test" }, switchBack: "on_reset" };

type Execution = { adapterType: string; model: unknown; instructionsFilePath: unknown; aiConnection: unknown; runId: string };

describeEmbeddedPostgres("usage-limit fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executions: Execution[] = [];
  let claudeHitsLimit = true;
  let codexErrorCode: string | null = null;

  function record(adapterType: string, ctx: AdapterExecutionContext) {
    executions.push({
      adapterType,
      model: ctx.config.model,
      instructionsFilePath: ctx.config.instructionsFilePath,
      aiConnection: (ctx.agent as { runtimeConfig?: Record<string, unknown> }).runtimeConfig?.aiConnection,
      runId: ctx.runId,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-usage-limit-fallback-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const claude = getServerAdapter("claude_local");
    const codex = getServerAdapter("codex_local");
    registerServerAdapter({
      ...claude,
      execute: async (ctx) => {
        record("claude_local", ctx);
        if (!claudeHitsLimit) return { exitCode: 0, signal: null, timedOut: false };
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
          errorCode: "provider_quota",
          errorFamily: "provider_quota",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          retryNotBefore: RESET_AT,
          resultJson: {
            executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            errorFamily: "provider_quota",
            retryNotBefore: RESET_AT,
            providerQuotaRetryNotBefore: RESET_AT,
          },
        };
      },
    });
    registerServerAdapter({
      ...codex,
      execute: async (ctx) => {
        record("codex_local", ctx);
        if (!codexErrorCode) return { exitCode: 0, signal: null, timedOut: false };
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Codex is not signed in.",
          errorCode: codexErrorCode,
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        };
      },
    });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    executions.length = 0;
    claudeHitsLimit = true;
    codexErrorCode = null;
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    unregisterServerAdapter("codex_local");
    await tempDb?.cleanup();
  });

  async function seedAgent(runtimeConfig: Record<string, unknown> = { usageLimitFallback: codexFallback }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fallback",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SKynet",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-primary-test", instructionsFilePath: "/agents/skynet/AGENTS.md", effort: "high" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 }, ...runtimeConfig },
      permissions: {},
    });
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return agent!;
  }

  async function waitForRun(runId: string) {
    await expect.poll(async () => (await heartbeat.getRun(runId))?.status, { timeout: 10_000, interval: 50 })
      .not.toMatch(/^(queued|running)$/);
    return (await heartbeat.getRun(runId))!;
  }

  async function retryOf(runId: string) {
    await expect.poll(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).length, { timeout: 10_000, interval: 50 })
      .toBe(1);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    return retry!;
  }

  async function runRetry(retry: typeof heartbeatRuns.$inferSelect) {
    await heartbeat.promoteDueScheduledRetries(new Date(retry.scheduledRetryAt!.getTime() + 1));
    await heartbeat.resumeQueuedRuns();
    return waitForRun(retry.id);
  }

  function dispatchOf(run: typeof heartbeatRuns.$inferSelect) {
    return (run.runnerProfileJson as Record<string, unknown> | null)?.adapterDispatch as Record<string, unknown> | undefined;
  }

  it("switches to the fallback right away and runs the retry on Codex with the agent's shared settings", async () => {
    const agent = await seedAgent();
    const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    const failed = await waitForRun(first!.id);
    expect(failed.errorCode).toBe("provider_quota");

    const retry = await retryOf(first!.id);
    const state = await readAgentUsageLimitFallbackState(db, agent.id);
    expect(state).toMatchObject({ activeUntil: RESET_AT, primaryAdapterType: "claude_local", fallbackAdapterType: "codex_local", sourceRunId: first!.id });
    expect(retry.scheduledRetryAt!.getTime()).toBeLessThan(Date.parse(RESET_AT));
    expect(retry.scheduledRetryAt!.getTime() - Date.now()).toBeLessThan(5 * 60_000);

    const finished = await runRetry(retry);
    expect(finished.status).toBe("succeeded");
    expect(dispatchOf(finished)).toEqual({ adapterType: "codex_local", lane: "fallback", primaryAdapterType: "claude_local", fallbackUntil: RESET_AT });
    expect(executions.map((execution) => execution.adapterType)).toEqual(["claude_local", "codex_local"]);
    expect(executions[1]).toMatchObject({ model: "gpt-fallback-test", instructionsFilePath: "/agents/skynet/AGENTS.md" });

    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(stored!.adapterType).toBe("claude_local");
  });

  it("waits for the reset as before when no fallback is configured", async () => {
    const agent = await seedAgent({});
    const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    await waitForRun(first!.id);
    const retry = await retryOf(first!.id);
    expect(retry.scheduledRetryAt!.toISOString()).toBe(RESET_AT);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
  });

  it("switches back to the primary once the reset time has passed", async () => {
    const agent = await seedAgent();
    claudeHitsLimit = false;
    await db.insert(agentRuntimeState).values({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: "claude_local",
      stateJson: { usageLimitFallback: {
        activeUntil: "2020-01-01T00:00:00.000Z",
        activatedAt: "2019-12-31T23:00:00.000Z",
        sourceRunId: randomUUID(),
        primaryAdapterType: "claude_local",
        fallbackAdapterType: "codex_local",
        reason: "provider_quota",
      } },
    });
    const run = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    const finished = await waitForRun(run!.id);
    expect(finished.status).toBe("succeeded");
    expect(dispatchOf(finished)).toEqual({ adapterType: "claude_local" });
    expect(executions.map((execution) => execution.adapterType)).toEqual(["claude_local"]);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
  });

  it("clears the primary's stale session for a task after a fallback turn", async () => {
    const agent = await seedAgent();
    const taskKey = "issue-task";
    await db.insert(agentTaskSessions).values({
      companyId: agent.companyId,
      agentId: agent.id,
      adapterType: "claude_local",
      taskKey,
      sessionParamsJson: { sessionId: "claude-session" },
      sessionDisplayId: "claude-session",
    });
    await activateUsageLimitFallback(db, {
      agent,
      run: { id: randomUUID(), runnerProfileJson: {}, responsibleUserId: null } as typeof heartbeatRuns.$inferSelect,
      retryNotBefore: new Date(RESET_AT),
      now: new Date(),
    });
    const run = await heartbeat.invoke(agent.id, "on_demand", { taskKey }, "manual");
    const finished = await waitForRun(run!.id);
    expect(dispatchOf(finished)?.lane).toBe("fallback");
    const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agent.id));
    expect(sessions.filter((session) => session.adapterType === "claude_local" && session.taskKey === taskKey)).toEqual([]);
  });

  async function activeFallback(agent: typeof agents.$inferSelect, until = RESET_AT) {
    const activation = await activateUsageLimitFallback(db, {
      agent,
      run: { id: randomUUID(), runnerProfileJson: {}, responsibleUserId: null } as typeof heartbeatRuns.$inferSelect,
      retryNotBefore: new Date(until),
      now: new Date(),
    });
    expect(activation.activated).toBe(true);
  }

  it("suspends a fallback that cannot sign in and makes the retry wait for the primary's reset", async () => {
    const agent = await seedAgent();
    await activeFallback(agent);
    codexErrorCode = "codex_auth_required";
    const run = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    const failed = await waitForRun(run!.id);
    expect(failed.errorCode).toBe("codex_auth_required");
    const retry = await retryOf(run!.id);
    expect(retry.scheduledRetryAt!.toISOString()).toBe(RESET_AT);
    expect((await readAgentUsageLimitFallbackState(db, agent.id))?.suspendedReason).toBe("codex_auth_required");
    expect(await resolveAdapterDispatchForClaim(db, agent, { responsibleUserId: null }, new Date())).toEqual({ adapterType: "claude_local" });
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).not.toBeNull();
  });

  it("drops the primary's account attribution from a fallback run that has no managed account", async () => {
    const agent = await seedAgent();
    await activeFallback(agent);
    const run = await heartbeat.invoke(agent.id, "on_demand", {
      aiConnection: { provider: "anthropic", method: "subscription", connectionId: randomUUID(), grantId: randomUUID(), identity: "primary" },
    }, "manual");
    const finished = await waitForRun(run!.id);
    expect(dispatchOf(finished)?.lane).toBe("fallback");
    expect((finished.contextSnapshot as Record<string, unknown>).aiConnection).toBeUndefined();
  });

  it("starts the fallback fresh in a new window by clearing its old task sessions", async () => {
    const agent = await seedAgent();
    await db.insert(agentTaskSessions).values({
      companyId: agent.companyId,
      agentId: agent.id,
      adapterType: "codex_local",
      taskKey: "issue-task",
      sessionParamsJson: { sessionId: "codex-old-window" },
      sessionDisplayId: "codex-old-window",
    });
    await activeFallback(agent);
    const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agent.id));
    expect(sessions.filter((session) => session.adapterType === "codex_local")).toEqual([]);
  });

  describe("state", () => {
    const quotaRun = (overrides: Partial<typeof heartbeatRuns.$inferSelect> = {}) =>
      ({ id: randomUUID(), runnerProfileJson: {}, responsibleUserId: null, ...overrides }) as typeof heartbeatRuns.$inferSelect;

    it("keeps the later end time when two quota failures race", async () => {
      const agent = await seedAgent();
      const now = new Date("2030-04-22T10:00:00.000Z");
      await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: new Date("2030-04-22T20:00:00.000Z"), now });
      await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: new Date("2030-04-22T15:00:00.000Z"), now });
      expect((await readAgentUsageLimitFallbackState(db, agent.id))?.activeUntil).toBe("2030-04-22T20:00:00.000Z");
    });

    it("uses a one-hour window when the provider gives no reset time", async () => {
      const agent = await seedAgent();
      const now = new Date("2030-04-22T10:00:00.000Z");
      await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: null, now });
      expect((await readAgentUsageLimitFallbackState(db, agent.id))?.activeUntil).toBe("2030-04-22T11:00:00.000Z");
    });

    it("does not activate again for a run that already ran on the fallback", async () => {
      const agent = await seedAgent();
      const result = await activateUsageLimitFallback(db, {
        agent,
        run: quotaRun({ runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", lane: "fallback" } } }),
        retryNotBefore: null,
        now: new Date(),
      });
      expect(result).toEqual({ activated: false, reason: "already_on_fallback" });
    });

    it("does not activate when the fallback account cannot be used", async () => {
      const agent = await seedAgent({
        usageLimitFallback: { ...codexFallback, aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } },
      });
      const result = await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: null, now: new Date() });
      expect(result).toEqual({ activated: false, reason: "fallback_ai_connection_unavailable" });
    });

    it("clears state at claim when the fallback was disabled, and only for the activation it saw", async () => {
      const agent = await seedAgent();
      const now = new Date("2030-04-22T10:00:00.000Z");
      const activation = await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: new Date(RESET_AT), now });
      expect(activation.activated).toBe(true);
      await clearUsageLimitFallbackState(db, agent.id, "2000-01-01T00:00:00.000Z");
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).not.toBeNull();
      const disabled = { ...agent, runtimeConfig: { ...(agent.runtimeConfig as Record<string, unknown>), usageLimitFallback: { ...codexFallback, enabled: false } } };
      expect(await resolveAdapterDispatchForClaim(db, disabled as typeof agent, { responsibleUserId: null }, now)).toEqual({ adapterType: "claude_local" });
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
    });
  });

  it("sends only this run to the primary when its user cannot use the fallback account, and keeps the agent's fallback", async () => {
    const agent = await seedAgent();
    await activeFallback(agent);
    const withAccount = {
      ...agent,
      runtimeConfig: { ...(agent.runtimeConfig as Record<string, unknown>), usageLimitFallback: { ...codexFallback, aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" } } },
    } as typeof agent;
    expect(await resolveAdapterDispatchForClaim(db, withAccount, { responsibleUserId: null }, new Date())).toEqual({ adapterType: "claude_local" });
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).not.toBeNull();
  });

  describe("effectiveAgentForRun", () => {
    it("strips the primary's provider credentials and routing from a fallback on another adapter", async () => {
      const agent = await seedAgent();
      const withEnv = {
        ...agent,
        adapterConfig: { ...(agent.adapterConfig as Record<string, unknown>), env: { ANTHROPIC_API_KEY: { type: "plain", value: "x" }, ANTHROPIC_BASE_URL: { type: "plain", value: "https://proxy" }, CLAUDE_CONFIG_DIR: { type: "plain", value: "/c" }, GITHUB_TOKEN: { type: "plain", value: "g" } } },
      } as typeof agent;
      const effective = effectiveAgentForRun(withEnv, { runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", lane: "fallback" } } });
      expect(Object.keys((effective.adapterConfig as Record<string, any>).env)).toEqual(["GITHUB_TOKEN"]);
    });

    it("keeps every primary setting for a second account on the same adapter", async () => {
      const agent = await seedAgent({
        aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        usageLimitFallback: {
          enabled: true,
          adapterType: "claude_local",
          adapterConfig: {},
          aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
          switchBack: "on_reset",
        },
      });
      const effective = effectiveAgentForRun(agent, { runnerProfileJson: { adapterDispatch: { adapterType: "claude_local", lane: "fallback" } } });
      expect(effective.adapterConfig).toEqual(agent.adapterConfig);
      expect((effective.runtimeConfig as Record<string, unknown>).aiConnection).toEqual({ provider: "anthropic", method: "subscription", mode: "responsible_user" });
    });

    it("overlays the fallback and removes the primary's AI connection when the fallback has none", async () => {
      const agent = await seedAgent({
        aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        usageLimitFallback: codexFallback,
      });
      const effective = effectiveAgentForRun(agent, { runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", lane: "fallback" } } });
      expect(effective.adapterType).toBe("codex_local");
      expect(effective.adapterConfig).toMatchObject({ model: "gpt-fallback-test", instructionsFilePath: "/agents/skynet/AGENTS.md" });
      expect(effective.adapterConfig).not.toHaveProperty("effort");
      expect((effective.runtimeConfig as Record<string, unknown>).aiConnection).toBeUndefined();
    });

    it("returns the stored agent on the primary lane", async () => {
      const agent = await seedAgent();
      expect(effectiveAgentForRun(agent, { runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } })).toBe(agent);
    });
  });
});
