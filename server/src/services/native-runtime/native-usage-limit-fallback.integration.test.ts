import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, ProviderFailure } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

type Harness = "codex" | "claude";
type RunnerTerminal = { harness: Harness; error: Record<string, unknown> & { providerFailure: ProviderFailure } };

// The acpx sidecar's terminal for the titles the real Claude Code 2.1.286 printed.
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

  async function failRunnerTurn(terminal: RunnerTerminal, withFallback: boolean) {
    const setup = runnerSetups[terminal.harness];
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Runner ${terminal.harness} ${withFallback ? "with" : "without"} fallback`,
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: setup.adapterConfig,
      runtimeConfig: withFallback ? { usageLimitFallback: { enabled: true, adapterType: setup.fallbackAdapterType } } : {},
    });
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
      contextSnapshot: { issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    // The turn failed after its provider session started, so this is not a bootstrap retry.
    await db.update(heartbeatRuns).set({
      runnerProfileJson: {
        sessionCheckpoint: { providerSessionId: "usage-limit-provider-session", providerIdentity: { threadId: "usage-limit-thread" } },
      },
    }).where(eq(heartbeatRuns.id, runId));

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
    const openInput = {
      identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId },
      backendKind: "mock" as const,
      sourceInstanceId: native.runnerInstanceId,
    };
    const turnFailed: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      runId,
      normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId,
      sourceEventId: "usage-limit-terminal",
      sourceSeq: 1,
      sourceKind: "runner",
      eventType: "turn.failed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload: { status: "failed", error: terminal.error },
    };
    // Like the Runner: the committed turn.failed event, then the terminal failure it raises from it.
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      await options.controlPlane.appendEvent(turnFailed);
      const code = typeof terminal.error.code === "string" ? terminal.error.code : "provider_turn_failed";
      throw new NativeProviderTerminalFailure(code, false, String(terminal.error.message), terminal.error.providerFailure);
    });
    await expect(executePaperclipNativeSession({
      db,
      execution,
      runnerInstanceId: native.runnerInstanceId,
      backend: {
        descriptor: async () => { throw new Error("Unexpected provider descriptor call"); },
        openSession: async () => { throw new Error("Unexpected provider session call"); },
      },
    })).rejects.toThrow();

    return { runId, issueId, agentId, ...await readOutcome(runId, issueId) };
  }

  async function readOutcome(runId: string, issueId: string) {
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const recoveryCards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return { failedRun, task, recoveryCards };
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

  it.each([
    ["Codex's usage limit", terminals.codexUsageLimit],
    ["Claude's weekly limit", terminals.claudeWeeklyLimit],
  ])("leaves the task to the fallback instead of blocking it (%s)", async (_label, terminal) => {
    const { failedRun, task, recoveryCards } = await failRunnerTurn(terminal, true);
    expect(failedRun).toMatchObject({ status: "failed", errorCode: "native_provider_usage_limit" });
    expect(failedRun.resultJson).toMatchObject({ usageLimitFallbackHandoff: true, providerFailure: terminal.error.providerFailure });
    expect(task.status).toBe("in_progress");
    expect(task.executionRunId).toBeNull();
    expect(recoveryCards).toEqual([]);
  });

  it.each([
    ["Codex's usage limit", terminals.codexUsageLimit],
    ["Claude's weekly limit", terminals.claudeWeeklyLimit],
  ])("still blocks the task for a person when the agent has no fallback (%s)", async (_label, terminal) => {
    const { failedRun, task, recoveryCards } = await failRunnerTurn(terminal, false);
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", cause: "native_provider_usage_limit" })]);
  });

  it.each([
    ["a rate limit", terminals.claudeApiKeyRateLimit, "native_provider_usage_limit"],
    ["the turn limit", terminals.claudeMaxTurns, "native_provider_terminal_failed"],
    ["the budget limit", terminals.claudeMaxBudget, "native_provider_terminal_failed"],
  ])("blocks the task as upstream does for %s, even with a fallback", async (_label, terminal, errorCode) => {
    const { failedRun, task, recoveryCards } = await failRunnerTurn(terminal, true);
    expect(failedRun.errorCode).toBe(errorCode);
    expect(failedRun.resultJson).not.toHaveProperty("usageLimitFallbackHandoff");
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", cause: errorCode })]);
  });

  it("blocks a handed-over task for a person when its release finds no fallback retry", async () => {
    const { runId, issueId } = await failRunnerTurn(terminals.claudeWeeklyLimit, true);
    await releaseRun(runId);
    const { task, recoveryCards } = await readOutcome(runId, issueId);
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board", status: "active" })]);
  });

  it("keeps a handed-over task for the fallback retry its release finds", async () => {
    const { runId, issueId, agentId } = await failRunnerTurn(terminals.claudeWeeklyLimit, true);
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "scheduled_retry", retryOfRunId: runId, invocationSource: "automation",
      triggerDetail: "system", scheduledRetryAt: new Date(), contextSnapshot: { issueId },
    });
    expect((await releaseRun(runId)).outcome.kind).toBe("released");
    const { task, recoveryCards } = await readOutcome(runId, issueId);
    expect(task.status).toBe("in_progress");
    expect(recoveryCards).toEqual([]);
  });
});
