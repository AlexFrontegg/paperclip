import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { ControlPlanePort, NativeExecutionInputV1, PersistedNativeSession, PrpEvent, ProviderFailure } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { executionProjectionForRun } from "../execution-projection.js";
import { pendingCaseHandoffForRun } from "../heartbeat/case-handoff-lifecycle.js";
import { createHeartbeatRetries, deferredUsageLimitFallbackRetries, type HeartbeatRetryDependencies } from "../heartbeat/retries.js";
import { createHeartbeatRunState } from "../heartbeat/run-state.js";
import { effectiveAgentForRun, readAgentUsageLimitFallbackState, resolveAdapterDispatchForClaim } from "../usage-limit-fallback.js";
import { agentProviderLimitCooldown } from "./native-startup-retry.js";
import { NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE } from "./native-runner-ownership.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

type Harness = "codex" | "claude";
type RunnerTerminal = { harness: Harness; error: Record<string, unknown> & { providerFailure: ProviderFailure } };

// Sidecar terminals; the session, weekly and 429 titles were captured from Claude Code 2.1.286.
function claudeTerminal(category: ProviderFailure["category"], title: string): RunnerTerminal {
  const message = "ACP agent reported a terminal limit failure.";
  return {
    harness: "claude",
    error: {
      message,
      code: "RUNTIME",
      providerFailure: {
        schema: "paperclip.provider-failure.v1",
        provider: "anthropic",
        phase: "turn",
        category,
        message: `${message}\n${title}`,
        retryability: category === "quota_exhausted" ? "requires_action" : "unknown",
      },
    },
  };
}

function claudeSessionLimitResettingAt(resetAt: Date): RunnerTerminal {
  const clock = resetAt.toLocaleString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s/g, "").toLowerCase();
  return claudeTerminal("quota_exhausted", `You've hit your session limit · resets ${clock} (UTC)`);
}

const codexUsageLimitMessage = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:31 PM.";
const terminals = {
  codexUsageLimit: {
    harness: "codex",
    error: {
      codexErrorInfo: "usageLimitExceeded",
      message: codexUsageLimitMessage,
      providerFailure: {
        schema: "paperclip.provider-failure.v1",
        provider: "openai",
        phase: "turn",
        category: "quota_exhausted",
        message: codexUsageLimitMessage,
        providerCode: "usageLimitExceeded",
        retryability: "requires_action",
      },
    },
  },
  claudeWeeklyLimit: claudeTerminal("quota_exhausted", "You've hit your weekly limit · resets Nov 12 at 6:49am (UTC)"),
  claudeApiKeyRateLimit: claudeTerminal("rate_limit", "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later."),
  claudeMaxTurns: claudeTerminal("unknown", "Reached maximum number of turns (5)"),
  claudeMaxBudget: claudeTerminal("unknown", "Reached maximum budget ($1)"),
} satisfies Record<string, RunnerTerminal>;

// A session.open 429 as the Runner types it, which an earlier attempt of the same run can leave behind.
const startupRateLimit: ProviderFailure = {
  schema: "paperclip.provider-failure.v1",
  provider: "anthropic",
  phase: "startup",
  category: "rate_limit",
  message: "API error: 429 This request would exceed your account's rate limit. Please try again later · model not changed",
  httpStatus: 429,
  retryability: "unknown",
};

const runnerSetups: Record<Harness, {
  adapterConfig: Record<string, unknown>;
  fallbackAdapterType: "claude_local" | "codex_local";
  provider: NativeExecutionInputV1["provider"];
  driverKind: string;
}> = {
  codex: {
    adapterConfig: { provider: "codex", model: "gpt-6-astra" },
    fallbackAdapterType: "claude_local",
    provider: { kind: "codex", model: "gpt-6-astra" },
    driverKind: "codex_app_server",
  },
  claude: {
    adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude-fable-5-1" },
    fallbackAdapterType: "codex_local",
    provider: { kind: "acpx", agent: "claude", model: "claude-fable-5-1" } as unknown as NativeExecutionInputV1["provider"],
    driverKind: "acpx_runtime",
  },
};

type TurnScenario = {
  withFallback?: boolean;
  contextSnapshot?: Record<string, unknown>;
  earlierProviderFailure?: ProviderFailure;
  taskStatusWhenTurnFails?: "blocked";
  errorAfterTurn?: Error;
  failedTurnCheckpointed?: boolean;
  runnerExecutionTarget?: AdapterExecutionTarget;
};

describe("a Paperclip Runner usage limit and the agent's usage-limit fallback", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-usage-limit-fallback-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Runner usage limit", issuePrefix: "RUL" });
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function failRunnerTurn(terminal: RunnerTerminal, scenario: TurnScenario = {}) {
    const setup = runnerSetups[terminal.harness];
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const [agent] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Runner ${terminal.harness}`,
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: setup.adapterConfig,
      runtimeConfig: scenario.withFallback === false ? {} : { usageLimitFallback: { enabled: true, adapterType: setup.fallbackAdapterType } },
    }).returning();
    const [issue] = await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Keep working after a usage limit",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: new Date(),
      contextSnapshot: { issueId, ...scenario.contextSnapshot },
      ...(scenario.earlierProviderFailure ? { resultJson: { providerFailure: scenario.earlierProviderFailure } } : {}),
    }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });

    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: setup.provider,
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: {
        normalizedSessionId: native.normalizedSessionId,
        driverKind: setup.driverKind,
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      } as NativeExecutionInputV1["session"],
      completionContract: {
        id: contract.id,
        sha256: contract.canonicalSha256,
        schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }),
      },
      interactionResponses: [],
      credentialBindings: [],
    };
    const identity = { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId };
    const runnerEvent = (sourceSeq: number, eventType: "turn.started" | "turn.failed", payload: PrpEvent["payload"]): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      runId,
      normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId,
      sourceEventId: `usage-limit-${eventType}`,
      sourceSeq,
      sourceKind: "runner",
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload,
    });
    const openSessionCheckpoint: PersistedNativeSession = {
      backendKind: "mock",
      driverKind: setup.driverKind,
      sessionId: native.normalizedSessionId,
      identity,
      providerSessionId: "usage-limit-provider-session",
    };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.checkpointSession!(openSessionCheckpoint);
      await options.controlPlane.appendEvent(runnerEvent(1, "turn.started", { status: "inProgress" }));
      await options.controlPlane.appendEvent(runnerEvent(2, "turn.failed", { status: "failed", error: terminal.error }));
      if (scenario.taskStatusWhenTurnFails) await db.update(issues).set({ status: scenario.taskStatusWhenTurnFails }).where(eq(issues.id, issueId));
      // Like the Runner's HarnessDriverBackend: the failed terminal is checkpointed before the typed failure is raised.
      if (scenario.failedTurnCheckpointed !== false) {
        await options.controlPlane.checkpointSession!({
          ...openSessionCheckpoint,
          terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "yielded" },
        });
      }
      const code = typeof terminal.error.code === "string" ? terminal.error.code : "provider_turn_failed";
      throw scenario.errorAfterTurn ?? new NativeProviderTerminalFailure(code, false, String(terminal.error.message), terminal.error.providerFailure);
    });
    await expect(executePaperclipNativeSession({
      db,
      execution,
      runnerInstanceId: native.runnerInstanceId,
      runnerExecutionTarget: scenario.runnerExecutionTarget,
      backend: {
        descriptor: async () => { throw new Error("Unexpected provider descriptor call"); },
        openSession: async () => { throw new Error("Unexpected provider session call"); },
      },
    })).rejects.toThrow();

    return { runId, issueId, agent, ...await readOutcome(runId, issueId) };
  }

  async function readOutcome(runId: string, issueId: string) {
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const recoveryCards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return { failedRun, task, recoveryCards };
  }

  function retries() {
    const runState = createHeartbeatRunState(db);
    return createHeartbeatRetries(db, {
      hasCaseHandoffForRun: async (run: { id: string; companyId: string }) => Boolean(await pendingCaseHandoffForRun(db, run.id, run.companyId)),
      getRun: runState.getRun,
      getAgent: runState.getAgent,
      resolveSessionBeforeForWakeup: runState.resolveSessionBeforeForWakeup,
      resolveResponsibleUserIdForRunContext: vi.fn(async () => null),
      getAgentInvokability: (agent: Parameters<typeof evaluateAgentInvokabilityFromDb>[1]) => evaluateAgentInvokabilityFromDb(db, agent),
      appendRunEvent: vi.fn(async () => undefined),
      escalatePlanApprovalResumeFailureNeedsAttention: vi.fn(async () => null),
      recordPlanApprovalResumeFailureRetry: vi.fn(async () => null),
      setRunStatusIfRunning: vi.fn(async () => ({ updated: false, run: null })),
      setWakeupStatus: vi.fn(async () => undefined),
      releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
      finalizeAgentStatus: vi.fn(async () => undefined),
      getWorktreeExecutionCutoff: vi.fn(async (): Promise<Date | null> => null),
      applyRunDispatchPostCommitEffects: vi.fn(),
      runDispatch: createRunDispatch(db),
    } as unknown as HeartbeatRetryDependencies);
  }

  async function releaseRun(runId: string) {
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => null,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    return release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true });
  }

  async function retriesOf(runId: string) {
    return db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
  }

  it.each([
    ["Codex's usage limit", terminals.codexUsageLimit],
    ["Claude's weekly limit", terminals.claudeWeeklyLimit],
  ])("leaves the task to the fallback after the Runner checkpointed its failed turn (%s)", async (_label, terminal) => {
    const { failedRun, task, recoveryCards } = await failRunnerTurn(terminal);
    expect(failedRun.runnerProfileJson).toMatchObject({ sessionCheckpoint: { terminal: { runTerminalState: "failed" } } });
    expect(failedRun).toMatchObject({ status: "failed", errorCode: "native_provider_usage_limit" });
    expect(failedRun.resultJson).toMatchObject({ usageLimitFallbackHandoff: true, providerFailure: terminal.error.providerFailure });
    expect(task.status).toBe("in_progress");
    expect(task.executionRunId).toBeNull();
    expect(recoveryCards).toEqual([]);
  });

  it("turns the fallback on before the run fails, so the agent's other queued work claims the fallback", async () => {
    const { runId, agent } = await failRunnerTurn(terminals.claudeWeeklyLimit);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toMatchObject({ reason: "provider_quota", sourceRunId: runId });
    const [otherTask] = await db.insert(issues).values({
      companyId, title: "Other work", status: "todo", workMode: "standard", assigneeAgentId: agent.id,
    }).returning();
    const [queuedRun] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, status: "queued", invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId: otherTask.id },
    }).returning();
    expect(await resolveAdapterDispatchForClaim(db, agent, queuedRun, new Date())).toMatchObject({ lane: "fallback", adapterType: "codex_local" });
  });

  it("sizes the fallback from the failure it hands off, not from an earlier attempt of the same run", async () => {
    const resetAt = new Date(Math.floor((Date.now() + 3 * 60 * 60_000) / 60_000) * 60_000);
    const sessionLimit = claudeSessionLimitResettingAt(resetAt);
    const { failedRun, agent } = await failRunnerTurn(sessionLimit, { earlierProviderFailure: startupRateLimit });
    expect((failedRun.resultJson as Record<string, unknown>).providerFailure).toEqual(sessionLimit.error.providerFailure);
    expect((await readAgentUsageLimitFallbackState(db, agent.id))?.activeUntil).toBe(resetAt.toISOString());
    const hold = await agentProviderLimitCooldown(db, { companyId, agentId: agent.id, now: new Date() });
    expect(hold?.resetAt.toISOString()).toBe(resetAt.toISOString());
  });

  it.each([
    ["Codex's usage limit", terminals.codexUsageLimit],
    ["Claude's weekly limit", terminals.claudeWeeklyLimit],
  ])("schedules the fallback's turn from the failure handler and keeps the task for it (%s)", async (_label, terminal) => {
    const { runId, issueId, agent, failedRun } = await failRunnerTurn(terminal);
    expect(await retries().handleUsageLimitFallbackAccountFailure(failedRun, agent)).toBe(true);
    const successors = await retriesOf(runId);
    expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry" })]);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toMatchObject({ reason: "provider_quota", sourceRunId: runId });
    const dispatch = await resolveAdapterDispatchForClaim(db, agent, successors[0]!, new Date());
    expect(dispatch).toMatchObject({ lane: "fallback", adapterType: runnerSetups[terminal.harness].fallbackAdapterType });
    expect(effectiveAgentForRun(agent, { runnerProfileJson: { adapterDispatch: dispatch } }).adapterType).toBe(runnerSetups[terminal.harness].fallbackAdapterType);
    expect((await releaseRun(runId)).outcome.kind).toBe("released");
    const { task, recoveryCards } = await readOutcome(runId, issueId);
    expect(task.status).toBe("in_progress");
    expect(recoveryCards).toEqual([]);
    expect(await executionProjectionForRun(db, companyId, runId)).toMatchObject({ phase: "completed", label: "Continued on usage-limit fallback" });
  });

  it.each([
    ["Codex's usage limit", terminals.codexUsageLimit],
    ["Claude's weekly limit", terminals.claudeWeeklyLimit],
  ])("still blocks the task for a person when the agent has no fallback (%s)", async (_label, terminal) => {
    const { failedRun, task, recoveryCards } = await failRunnerTurn(terminal, { withFallback: false });
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", cause: "native_provider_usage_limit" })]);
  });

  it.each([
    ["a rate limit", terminals.claudeApiKeyRateLimit, "native_provider_usage_limit"],
    ["the turn limit", terminals.claudeMaxTurns, "native_provider_terminal_failed"],
    ["the budget limit", terminals.claudeMaxBudget, "native_provider_terminal_failed"],
  ])("blocks the task as upstream does for %s, even with a fallback", async (_label, terminal, errorCode) => {
    const { failedRun, task, recoveryCards, agent } = await failRunnerTurn(terminal);
    expect(failedRun.errorCode).toBe(errorCode);
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", cause: errorCode })]);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
  });

  it.each([
    ["another error follows the usage-limit turn", { errorAfterTurn: new Error("provider_transport_failed: the event stream closed") }],
    ["the Runner targets a remote environment", { runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } as AdapterExecutionTarget }],
  ])("blocks the task for a person when %s", async (_label, scenario) => {
    const { failedRun, task, recoveryCards, agent } = await failRunnerTurn(terminals.claudeWeeklyLimit, scenario);
    expect(failedRun).toMatchObject({ status: "failed", errorCode: "native_provider_usage_limit" });
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", status: "active" })]);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
  });

  it("keeps the run's ownership hold when an adopted Runner replays the usage-limit turn but cannot be verified", async () => {
    const { failedRun, agent } = await failRunnerTurn(terminals.claudeWeeklyLimit, {
      errorAfterTurn: new Error("native_adopted_runner_authentication_timeout"),
      failedTurnCheckpointed: false,
    });
    expect(failedRun).toMatchObject({ status: "running", errorCode: NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE });
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toBeNull();
  });

  it("leaves a task that moved away from the run as it is, with the fallback on for the agent's other work", async () => {
    const { runId, agent, failedRun, task, recoveryCards } = await failRunnerTurn(terminals.claudeWeeklyLimit, { taskStatusWhenTurnFails: "blocked" });
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([]);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toMatchObject({ reason: "provider_quota", sourceRunId: runId });
    expect(await retries().handleUsageLimitFallbackAccountFailure(failedRun, agent)).toBe(false);
    expect(await retriesOf(runId)).toEqual([]);
  });

  it("blocks a handed-over task for a person when its release finds no fallback retry", async () => {
    const { runId, issueId } = await failRunnerTurn(terminals.claudeWeeklyLimit);
    await releaseRun(runId);
    const { task, recoveryCards } = await readOutcome(runId, issueId);
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({
      ownerType: "board",
      status: "active",
      cause: "native_continuation_requires_reconciliation",
      evidence: expect.objectContaining({ originalFailureCode: "native_provider_usage_limit" }),
    })]);
    expect(await executionProjectionForRun(db, companyId, runId)).toMatchObject({ phase: "recovery_needed" });
  });

  it("blocks a user's continuation for that user, whose next retry runs on the fallback", async () => {
    const explicitUserContinuation = { previousRunId: randomUUID(), commentId: randomUUID() };
    const { runId, issueId, agent, failedRun } = await failRunnerTurn(terminals.claudeWeeklyLimit, { contextSnapshot: { explicitUserContinuation } });
    expect(await retries().handleUsageLimitFallbackAccountFailure(failedRun, agent)).toBe(false);
    expect(deferredUsageLimitFallbackRetries.has(runId)).toBe(false);
    await releaseRun(runId);
    const { task, recoveryCards } = await readOutcome(runId, issueId);
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", status: "active" })]);
    expect(await readAgentUsageLimitFallbackState(db, agent.id)).toMatchObject({ reason: "provider_quota", sourceRunId: runId });
  });
});
