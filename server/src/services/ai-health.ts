import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  type Db,
  agentRuntimeState,
  agents,
  companyMemberships,
  connectionGrantMembers,
  connectionGrants,
  heartbeatRuns,
  toolConnections,
} from "@paperclipai/db";
import {
  aiConnectionBindingSchema,
  readUsageLimitFallbackConfig,
  usageLimitFallbackStateSchema,
  type AgentAiHealth,
  type AgentBackupIssue,
  type AiConnectionBinding,
  type CompanyAiConnectionHealth,
  type CompanyAiHealth,
  type UsageLimitFallbackState,
} from "@paperclipai/shared";
import { aiConnectionStatus, canUseCredential } from "./ai-connections.js";
import { fallbackConfigProblem, usageLimitFallbackLaneView } from "./usage-limit-fallback.js";

type ManagedBinding = Extract<AiConnectionBinding, { connectionId: string }>;

/** Only shared and delegated bindings name one account; a responsible user's account differs per run. */
function managedBinding(value: unknown): ManagedBinding | null {
  const parsed = aiConnectionBindingSchema.safeParse(value);
  return parsed.success && parsed.data.mode !== "responsible_user" ? parsed.data : null;
}

function isQuotaFailure(run: { errorCode: string | null; errorFamily: string | null }): boolean {
  return run.errorFamily === "provider_quota" || (run.errorFamily === null && run.errorCode === "provider_quota");
}

/**
 * Company-wide view of the AI accounts agents use and of agents on their fallback or with no working AI.
 * The lane comes from the same decision a run claim makes. Holds no credential material, and names only
 * the accounts the viewer may use.
 */
export function aiHealthService(db: Db) {
  async function loadAccounts(companyId: string) {
    const [accountRows, activeUserIds, audience] = await Promise.all([
      db.select({
        connectionId: toolConnections.id,
        name: toolConnections.name,
        enabled: toolConnections.enabled,
        status: toolConnections.status,
        healthStatus: toolConnections.healthStatus,
        aiConfig: sql<unknown>`${toolConnections.config} -> 'ai'`,
        aiIsolatedSubscription: sql<unknown>`${toolConnections.config} -> 'aiIsolatedSubscription'`,
        grantId: connectionGrants.id,
        grantStatus: connectionGrants.status,
        grantKind: connectionGrants.kind,
        grantSubjectUserId: connectionGrants.subjectUserId,
      })
        .from(toolConnections)
        .innerJoin(connectionGrants, and(
          eq(connectionGrants.companyId, toolConnections.companyId),
          eq(connectionGrants.connectionId, toolConnections.id),
        ))
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.connectionPurpose, "ai"))),
      db.select({ userId: companyMemberships.principalId })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        )),
      db.select({ grantId: connectionGrantMembers.grantId, subjectType: connectionGrantMembers.subjectType, subjectId: connectionGrantMembers.subjectId })
        .from(connectionGrantMembers)
        .where(eq(connectionGrantMembers.companyId, companyId)),
    ]);
    return { accountRows, activeUserIds: new Set(activeUserIds.map((row) => row.userId)), audience };
  }

  /** The latest finished fallback-lane run of each agent started since its fallback did, to see whether the fallback hit its own limit. */
  async function fallbackQuotaFailures(companyId: string, activations: Map<string, string>): Promise<Set<string>> {
    if (!activations.size) return new Set();
    const earliest = new Date(Math.min(...[...activations.values()].map((at) => Date.parse(at))));
    const latestRuns = await db.selectDistinctOn([heartbeatRuns.agentId], {
      agentId: heartbeatRuns.agentId,
      startedAt: heartbeatRuns.startedAt,
      errorCode: heartbeatRuns.errorCode,
      errorFamily: sql<string | null>`${heartbeatRuns.resultJson} ->> 'errorFamily'`,
    })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.agentId, [...activations.keys()]),
        gte(heartbeatRuns.startedAt, earliest),
        isNotNull(heartbeatRuns.finishedAt),
        sql`${heartbeatRuns.runnerProfileJson} -> 'adapterDispatch' ->> 'lane' = 'fallback'`,
      ))
      .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.finishedAt));
    return new Set(latestRuns
      .filter((run) => run.startedAt && run.startedAt.getTime() >= Date.parse(activations.get(run.agentId)!) && isQuotaFailure(run))
      .map((run) => run.agentId));
  }

  async function summarize(companyId: string, viewerUserId: string, now = new Date()): Promise<CompanyAiHealth> {
    const [agentRows, stateRows, accounts] = await Promise.all([
      db.select({
        id: agents.id,
        adapterType: agents.adapterType,
        model: sql<unknown>`${agents.adapterConfig} -> 'model'`,
        aiConnection: sql<unknown>`${agents.runtimeConfig} -> 'aiConnection'`,
        usageLimitFallback: sql<unknown>`${agents.runtimeConfig} -> 'usageLimitFallback'`,
      })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
        .orderBy(agents.name, agents.id),
      db.select({ agentId: agentRuntimeState.agentId, fallbackState: sql<unknown>`${agentRuntimeState.stateJson} -> 'usageLimitFallback'` })
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.companyId, companyId)),
      loadAccounts(companyId),
    ]);
    const stateByAgentId = new Map<string, UsageLimitFallbackState>();
    for (const row of stateRows) {
      const parsed = usageLimitFallbackStateSchema.safeParse(row.fallbackState);
      if (parsed.success) stateByAgentId.set(row.agentId, parsed.data);
    }

    const connectionsByGrant = new Map<string, CompanyAiConnectionHealth>();
    function trackAccount(binding: ManagedBinding | null): CompanyAiConnectionHealth | null {
      if (!binding) return null;
      const grantKey = `${binding.connectionId}:${binding.grantId}`;
      const known = connectionsByGrant.get(grantKey);
      if (known) return known;
      const account = accounts.accountRows.find((row) => row.connectionId === binding.connectionId && row.grantId === binding.grantId);
      const ownerLeft = account?.grantKind === "user" && !accounts.activeUserIds.has(account.grantSubjectUserId ?? "");
      const visible = account !== undefined && canUseCredential(
        { kind: account.grantKind, subjectUserId: account.grantSubjectUserId },
        viewerUserId,
        accounts.audience.filter((member) => member.grantId === account.grantId),
      );
      const entry: CompanyAiConnectionHealth = {
        key: `account-${connectionsByGrant.size + 1}`,
        id: binding.connectionId,
        name: visible ? account.name : null,
        provider: binding.provider,
        status: !account
          ? "missing"
          : ownerLeft
            ? "needs_attention"
            : aiConnectionStatus(
              { enabled: account.enabled, status: account.status, healthStatus: account.healthStatus, config: { ai: account.aiConfig, aiIsolatedSubscription: account.aiIsolatedSubscription } },
              { status: account.grantStatus },
            ),
      };
      connectionsByGrant.set(grantKey, entry);
      return entry;
    }

    const views = agentRows.map((agent) => {
      const runtimeConfig = { aiConnection: agent.aiConnection, usageLimitFallback: agent.usageLimitFallback };
      const setup = { adapterType: agent.adapterType, runtimeConfig };
      const fallback = readUsageLimitFallbackConfig(runtimeConfig);
      const primaryAccount = trackAccount(managedBinding(agent.aiConnection));
      const fallbackAccount = fallback ? trackAccount(managedBinding(fallback.aiConnection)) : null;
      const primaryBroken = Boolean(primaryAccount && primaryAccount.status !== "connected");
      const fallbackBroken = Boolean(fallbackAccount && fallbackAccount.status !== "connected");
      const state = stateByAgentId.get(agent.id) ?? null;
      const laneView = usageLimitFallbackLaneView({
        agent: setup,
        state,
        now,
        primarySignedOut: primaryAccount ? primaryBroken : null,
        fallbackAccountUsable: fallback !== null && !fallbackBroken,
      });
      const current = !laneView.stale && laneView.fallbackUntil !== null;
      return { agent, setup, fallback, primaryAccount, fallbackAccount, primaryBroken, fallbackBroken, state, laneView, current };
    });

    const activations = new Map(views
      .filter((view) => view.current && view.laneView.lane === "fallback")
      .map((view) => [view.agent.id, view.state!.activatedAt] as const));
    const fallbackOutOfQuota = await fallbackQuotaFailures(companyId, activations);

    const agentHealth: AgentAiHealth[] = [];
    for (const view of views) {
      const { agent, fallback, state, laneView, current } = view;
      const onFallback = current && laneView.lane === "fallback";
      const outOfQuota = onFallback && fallbackOutOfQuota.has(agent.id);
      let backupIssue: AgentBackupIssue | null = null;
      if (!fallback || fallbackConfigProblem(view.setup, fallback)) backupIssue = "not_configured";
      else if (view.fallbackBroken) backupIssue = "account";
      else if (current && state?.suspendedReason) backupIssue = "suspended";
      else if (outOfQuota) backupIssue = "usage_limit";
      else if (!current && view.primaryBroken && !fallback.switchWhenUnavailable) backupIssue = "no_switch";
      // A current fallback window means the primary is unavailable until it ends.
      const noWorkingAi = current
        ? laneView.lane === "primary" || outOfQuota
        : view.primaryBroken && backupIssue !== null;
      if (!current && !noWorkingAi && backupIssue !== "account") continue;
      agentHealth.push({
        agentId: agent.id,
        lane: onFallback ? "fallback" : "primary",
        fallbackActive: current,
        noWorkingAi,
        backupIssue,
        since: current ? state!.activatedAt : null,
        until: current ? laneView.fallbackUntil : null,
        waitForReconnect: current && Boolean(state!.waitForReconnect),
        reason: current ? state!.reason : null,
        suspendedReason: current ? state!.suspendedReason ?? null : null,
        primaryAdapterType: agent.adapterType,
        primaryModel: typeof agent.model === "string" && agent.model ? agent.model : null,
        primaryConnectionKey: view.primaryAccount?.key ?? null,
        fallbackAdapterType: fallback?.adapterType ?? null,
        fallbackModel: fallback?.adapterConfig.model ?? null,
        fallbackConnectionKey: view.fallbackAccount?.key ?? null,
      });
    }
    return { connections: [...connectionsByGrant.values()], agents: agentHealth };
  }
  return { summarize };
}
