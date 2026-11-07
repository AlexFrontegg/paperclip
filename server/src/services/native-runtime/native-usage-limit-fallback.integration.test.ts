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
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

type Harness = "codex" | "claude";

const claudeUsageLimit = {
  schema: "paperclip.provider-failure.v1",
  provider: "anthropic",
  phase: "turn",
  category: "quota_exhausted",
  message: "Claude usage limit reached",
  retryAt: "2030-04-22T18:00:00.000Z",
  retryability: "requires_action",
} as const;

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

  async function failRunnerTurnOnUsageLimit(harness: Harness, withFallback: boolean) {
    const setup = runnerSetups[harness];
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Runner ${harness} ${withFallback ? "with" : "without"} fallback`,
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
    const codexUsageLimitEvent: PrpEvent = {
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
      payload: { status: "failed", error: { codexErrorInfo: "usageLimitExceeded", message: "Usage limit reached" } },
    };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      if (harness === "claude") {
        throw new NativeProviderTerminalFailure("billing_error", false, "Claude usage limit reached", claudeUsageLimit);
      }
      await options.controlPlane.appendEvent(codexUsageLimitEvent);
      throw new Error("provider turn stopped");
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

    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    const recoveryCards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return { failedRun, task, recoveryCards };
  }

  it.each(["codex", "claude"] as const)("leaves the task to the fallback instead of blocking it (%s on the Runner)", async (harness) => {
    const { failedRun, task, recoveryCards } = await failRunnerTurnOnUsageLimit(harness, true);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.errorCode).toBe(harness === "codex" ? "native_provider_usage_limit" : "native_provider_terminal_failed");
    if (harness === "claude") {
      expect(failedRun.resultJson?.providerFailure).toMatchObject({ category: "quota_exhausted", retryAt: claudeUsageLimit.retryAt });
    }
    expect(task.status).toBe("in_progress");
    expect(task.executionRunId).toBeNull();
    expect(recoveryCards).toEqual([]);
  });

  it.each(["codex", "claude"] as const)("still blocks the task for a person when the agent has no fallback (%s on the Runner)", async (harness) => {
    const { task, recoveryCards } = await failRunnerTurnOnUsageLimit(harness, false);
    expect(task.status).toBe("blocked");
    expect(recoveryCards).toEqual([expect.objectContaining({ ownerType: "board" })]);
  });
});
