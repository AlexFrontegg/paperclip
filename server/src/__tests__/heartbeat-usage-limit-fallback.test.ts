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
  isRunAiAccountFailure,
  readAgentUsageLimitFallbackState,
  resolveAdapterDispatchForClaim,
  suspendUsageLimitFallback,
} from "../services/usage-limit-fallback.ts";

vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

// Fake saved AI accounts by provider: `selectable` pass the account check, `broken` fail while being prepared.
// With `selectable` null the real account services run.
const aiAccounts = vi.hoisted(() => ({ broken: [] as string[], selectable: null as string[] | null }));
vi.mock("../services/ai-connection-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ai-connection-runtime.js")>();
  return {
    ...actual,
    prepareManagedAiRuntime: async (...args: Parameters<typeof actual.prepareManagedAiRuntime>) => {
      const { binding, config } = args[1];
      if (aiAccounts.broken.includes(binding.provider)) throw new Error("Reconnect this AI account");
      if (!aiAccounts.selectable) return actual.prepareManagedAiRuntime(...args);
      const attribution = { provider: binding.provider, method: binding.method, connectionId: randomUUID(), grantId: randomUUID() };
      return { config, attribution, identity: `${binding.provider}-identity`, cleanup: async () => {} } as unknown as Awaited<ReturnType<typeof actual.prepareManagedAiRuntime>>;
    },
  };
});
vi.mock("../services/ai-connections.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ai-connections.js")>();
  return {
    ...actual,
    aiConnectionService: (...args: Parameters<typeof actual.aiConnectionService>) => {
      const service = actual.aiConnectionService(...args);
      if (!aiAccounts.selectable) return service;
      const selectable = aiAccounts.selectable;
      return {
        ...service,
        select: async (input: Parameters<typeof service.select>[0]) => {
          if (!selectable.includes(input.binding.provider)) throw new Error("Reconnect or validate the selected AI account");
          return {} as Awaited<ReturnType<typeof service.select>>;
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const RESET_AT = "2030-04-22T21:00:00.000Z";
const CODEX_RESET_AT = "2030-04-23T21:00:00.000Z";
const openAiBinding = { provider: "openai", method: "api_key", mode: "responsible_user" };
const anthropicBinding = { provider: "anthropic", method: "api_key", mode: "responsible_user" };
const codexFallback = { enabled: true, adapterType: "codex_local", adapterConfig: { model: "gpt-fallback-test" }, switchBack: "on_reset" };
const claudeFallback = { enabled: true, adapterType: "claude_local", adapterConfig: { model: "claude-fallback-test" }, switchBack: "on_reset" };
const outage = { errorCode: "transient_upstream", errorFamily: "transient_upstream" };

type Failure = { errorCode: string; errorFamily?: string };

function failedExecution(failure: Failure) {
  const family = failure.errorFamily ? { errorFamily: failure.errorFamily } : {};
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: failure.errorCode,
    errorCode: failure.errorCode,
    ...family,
    executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false },
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, ...family },
  };
}

type Execution = { adapterType: string; model: unknown; instructionsFilePath: unknown; aiConnection: unknown; runId: string };

describeEmbeddedPostgres("usage-limit fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executions: Execution[] = [];
  let claudeHitsLimit = true;
  let claudeFailures: Failure[] = [];
  let codexFailures: Failure[] = [];
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
        const failure = claudeFailures.shift();
        if (failure) return failedExecution(failure);
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
        const failure = codexFailures.shift();
        if (failure) return failedExecution(failure);
        if (!codexErrorCode) return { exitCode: 0, signal: null, timedOut: false };
        if (codexErrorCode === "provider_quota") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: "You've hit your usage limit.",
            errorCode: "provider_quota",
            errorFamily: "provider_quota",
            executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            retryNotBefore: CODEX_RESET_AT,
            resultJson: {
              executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
              errorFamily: "provider_quota",
              retryNotBefore: CODEX_RESET_AT,
              providerQuotaRetryNotBefore: CODEX_RESET_AT,
            },
          };
        }
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
    claudeFailures = [];
    codexFailures = [];
    codexErrorCode = null;
    aiAccounts.broken = [];
    aiAccounts.selectable = null;
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    unregisterServerAdapter("codex_local");
    await tempDb?.cleanup();
  });

  async function seedAgent(runtimeConfig: Record<string, unknown> = { usageLimitFallback: codexFallback }, adapterType = "claude_local") {
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
      adapterType,
      adapterConfig: { model: `${adapterType}-primary-test`, instructionsFilePath: "/agents/skynet/AGENTS.md", effort: "high" },
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
    // Sessions are settled just after the run is marked finished.
    await expect.poll(async () => {
      const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agent.id));
      return sessions.filter((session) => session.adapterType === "claude_local" && session.taskKey === taskKey);
    }, { timeout: 10_000, interval: 50 }).toEqual([]);
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

  it("suspends a fallback whose account cannot be prepared and makes the retry wait for the primary's reset", async () => {
    const agent = await seedAgent({ usageLimitFallback: { ...codexFallback, aiConnection: openAiBinding } });
    aiAccounts.selectable = ["openai"];
    aiAccounts.broken = ["openai"];
    await activeFallback(agent);
    const run = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    const failed = await waitForRun(run!.id);
    expect(failed.errorCode).toBe("configuration_incomplete");
    const retry = await retryOf(run!.id);
    expect(retry.scheduledRetryAt!.toISOString()).toBe(RESET_AT);
    expect((await readAgentUsageLimitFallbackState(db, agent.id))?.suspendedReason).toBe("configuration_incomplete");
    expect(executions).toEqual([]);
  });

  it("still waits for the primary when the broken fallback used the last retry", async () => {
    const agent = await seedAgent();
    claudeFailures = [outage];
    codexErrorCode = "codex_auth_required";
    const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    await waitForRun(first!.id);
    const quotaRun = await runRetry(await retryOf(first!.id));
    expect(quotaRun.errorCode).toBe("provider_quota");
    const fallbackRun = await runRetry(await retryOf(quotaRun.id));
    expect(dispatchOf(fallbackRun)?.lane).toBe("fallback");
    expect(fallbackRun.errorCode).toBe("codex_auth_required");
    const waitForPrimary = await retryOf(fallbackRun.id);
    expect(waitForPrimary.scheduledRetryAt!.toISOString()).toBe(RESET_AT);
  });

  it("waits only until the primary is back when the fallback hits its own usage limit", async () => {
    const agent = await seedAgent();
    const primaryBackAt = "2030-04-22T18:00:00.000Z";
    await activeFallback(agent, primaryBackAt);
    codexErrorCode = "provider_quota";
    const run = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
    const failed = await waitForRun(run!.id);
    expect(dispatchOf(failed)?.lane).toBe("fallback");
    const retry = await retryOf(run!.id);
    expect(retry.scheduledRetryAt!.toISOString()).toBe(primaryBackAt);
  });

  it("drops a fallback account attribution copied into a primary run", async () => {
    const agent = await seedAgent();
    claudeHitsLimit = false;
    const run = await heartbeat.invoke(agent.id, "on_demand", {
      aiConnection: { provider: "openai", method: "api_key", connectionId: randomUUID(), grantId: randomUUID(), identity: "fallback" },
    }, "manual");
    const finished = await waitForRun(run!.id);
    expect(dispatchOf(finished)).toEqual({ adapterType: "claude_local" });
    expect((finished.contextSnapshot as Record<string, unknown>).aiConnection).toBeUndefined();
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

    it("suspends without touching a newer end time, and does nothing once the fallback was cleared", async () => {
      const agent = await seedAgent();
      const now = new Date("2030-04-22T10:00:00.000Z");
      await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: new Date("2030-04-22T15:00:00.000Z"), now });
      await activateUsageLimitFallback(db, { agent, run: quotaRun(), retryNotBefore: new Date(RESET_AT), now });
      expect(await suspendUsageLimitFallback(db, agent.id, "codex_auth_required", now)).toMatchObject({ activeUntil: RESET_AT, suspendedReason: "codex_auth_required" });
      await clearUsageLimitFallbackState(db, agent.id);
      expect(await suspendUsageLimitFallback(db, agent.id, "codex_auth_required", now)).toBeNull();
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

  it("resets a task's sessions on both the primary and the fallback adapter, and no others", async () => {
    const agent = await seedAgent();
    const session = (adapterType: string) => ({
      companyId: agent.companyId,
      agentId: agent.id,
      adapterType,
      taskKey: "issue-task",
      sessionParamsJson: { sessionId: `${adapterType}-session` },
      sessionDisplayId: `${adapterType}-session`,
    });
    await db.insert(agentTaskSessions).values([session("claude_local"), session("codex_local"), session("gemini_local")]);
    const reset = await heartbeat.resetRuntimeSession(agent.id, { taskKey: "issue-task" });
    expect(reset?.clearedTaskSessions).toBe(2);
    const remaining = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agent.id));
    expect(remaining.map((row) => row.adapterType)).toEqual(["gemini_local"]);
  });

  describe("Codex as the primary", () => {
    it("switches to Claude when Codex hits its usage limit", async () => {
      const agent = await seedAgent({ usageLimitFallback: claudeFallback }, "codex_local");
      codexErrorCode = "provider_quota";
      claudeHitsLimit = false;
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      expect((await waitForRun(first!.id)).errorCode).toBe("provider_quota");
      const finished = await runRetry(await retryOf(first!.id));
      expect(finished.status).toBe("succeeded");
      expect(dispatchOf(finished)).toMatchObject({ adapterType: "claude_local", lane: "fallback", primaryAdapterType: "codex_local" });
      expect(executions.map((execution) => execution.adapterType)).toEqual(["codex_local", "claude_local"]);
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).toMatchObject({ reason: "provider_quota", activeUntil: CODEX_RESET_AT });
    });

    it("switches to Claude when Codex stays down after one retry", async () => {
      const agent = await seedAgent({ usageLimitFallback: { ...claudeFallback, switchWhenUnavailable: true } }, "codex_local");
      codexFailures = [outage, outage];
      claudeHitsLimit = false;
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      await waitForRun(first!.id);
      await runRetry(await retryOf(first!.id));
      const finished = await runRetry(await retryOf((await retryOf(first!.id)).id));
      expect(finished.status).toBe("succeeded");
      expect(executions.map((execution) => execution.adapterType)).toEqual(["codex_local", "codex_local", "claude_local"]);
      expect((await readAgentUsageLimitFallbackState(db, agent.id))?.reason).toBe("provider_outage");
    });
  });

  describe("when the primary is down or signed out", () => {
    const whenUnavailable = { usageLimitFallback: { ...codexFallback, switchWhenUnavailable: true } };

    it("retries Claude once, then runs on Codex for 30 minutes", async () => {
      const agent = await seedAgent(whenUnavailable);
      claudeFailures = [outage, outage];
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      await waitForRun(first!.id);
      const secondTry = await runRetry(await retryOf(first!.id));
      expect(dispatchOf(secondTry)).toEqual({ adapterType: "claude_local" });
      const activatedAt = Date.now();
      const finished = await runRetry(await retryOf(secondTry.id));
      expect(finished.status).toBe("succeeded");
      expect(dispatchOf(finished)?.lane).toBe("fallback");
      const state = await readAgentUsageLimitFallbackState(db, agent.id);
      expect(state?.reason).toBe("provider_outage");
      expect(Date.parse(state!.activeUntil) - activatedAt).toBeGreaterThan(25 * 60_000);
      expect(Date.parse(state!.activeUntil) - activatedAt).toBeLessThan(35 * 60_000);
    });

    it("keeps retrying the primary when the fallback is set for usage limits only", async () => {
      const agent = await seedAgent();
      claudeFailures = [outage, outage];
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      await waitForRun(first!.id);
      const secondTry = await runRetry(await retryOf(first!.id));
      expect(secondTry.errorCode).toBe("transient_upstream");
      await retryOf(secondTry.id);
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
    });

    it("moves to Codex right away when Claude's login fails", async () => {
      const agent = await seedAgent(whenUnavailable);
      claudeFailures = [{ errorCode: "claude_auth_required" }];
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      expect((await waitForRun(first!.id)).errorCode).toBe("claude_auth_required");
      const finished = await runRetry(await retryOf(first!.id));
      expect(finished.status).toBe("succeeded");
      expect(dispatchOf(finished)?.lane).toBe("fallback");
      const state = await readAgentUsageLimitFallbackState(db, agent.id);
      expect(state?.reason).toBe("primary_signed_out");
      expect(state?.waitForReconnect).toBeUndefined();
    });

    it("moves to Codex when Claude's managed account cannot be prepared, until it is reconnected", async () => {
      const agent = await seedAgent({
        aiConnection: anthropicBinding,
        usageLimitFallback: { ...codexFallback, aiConnection: openAiBinding, switchWhenUnavailable: true },
      });
      aiAccounts.selectable = ["openai"];
      aiAccounts.broken = ["anthropic"];
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      expect((await waitForRun(first!.id)).errorCode).toBe("configuration_incomplete");
      const finished = await runRetry(await retryOf(first!.id));
      expect(finished.status).toBe("succeeded");
      expect(dispatchOf(finished)?.lane).toBe("fallback");
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).toMatchObject({ reason: "primary_signed_out", waitForReconnect: true });
      expect(executions.map((execution) => execution.adapterType)).toEqual(["codex_local"]);
    });

    it("does not switch for a problem with the work itself", async () => {
      const agent = await seedAgent(whenUnavailable);
      claudeFailures = [{ errorCode: "claude_refusal", errorFamily: "model_refusal" }];
      const first = await heartbeat.invoke(agent.id, "on_demand", {}, "manual");
      await waitForRun(first!.id);
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
      expect(executions.map((execution) => execution.adapterType)).toEqual(["claude_local"]);
    });

    it("stays on the fallback until a signed-out managed primary account is reconnected", async () => {
      const agent = await seedAgent({
        aiConnection: anthropicBinding,
        usageLimitFallback: { ...codexFallback, aiConnection: openAiBinding, switchWhenUnavailable: true },
      });
      aiAccounts.selectable = ["openai"];
      const now = new Date("2030-04-22T10:00:00.000Z");
      const activation = await activateUsageLimitFallback(db, {
        agent,
        run: { id: randomUUID(), runnerProfileJson: {}, responsibleUserId: null } as typeof heartbeatRuns.$inferSelect,
        reason: "primary_signed_out",
        retryNotBefore: null,
        now,
      });
      expect(activation).toMatchObject({ activated: true, state: { activeUntil: "2030-04-22T10:30:00.000Z", waitForReconnect: true } });

      const later = new Date("2030-04-22T12:00:00.000Z");
      expect(await resolveAdapterDispatchForClaim(db, agent, { responsibleUserId: null }, later))
        .toMatchObject({ lane: "fallback", fallbackUntil: "2030-04-22T12:30:00.000Z" });
      expect((await readAgentUsageLimitFallbackState(db, agent.id))?.activeUntil).toBe("2030-04-22T12:30:00.000Z");

      aiAccounts.selectable = ["openai", "anthropic"];
      expect(await resolveAdapterDispatchForClaim(db, agent, { responsibleUserId: null }, later)).toEqual({ adapterType: "claude_local" });
      expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
    });
  });

  it("treats only failures of the fallback's own account as a broken fallback", () => {
    expect(isRunAiAccountFailure({ errorCode: "codex_auth_required", resultJson: null })).toBe(true);
    expect(isRunAiAccountFailure({
      errorCode: "configuration_incomplete",
      resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } },
    })).toBe(true);
    expect(isRunAiAccountFailure({
      errorCode: "configuration_incomplete",
      resultJson: { configurationIncomplete: { reason: "unresolved_base_ref" } },
    })).toBe(false);
    expect(isRunAiAccountFailure({ errorCode: "adapter_failed", resultJson: null })).toBe(false);
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
