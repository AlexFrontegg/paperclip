import { and, eq, ne } from "drizzle-orm";
import { type Db, agentRuntimeState, agents, connectionGrants, toolConnections } from "@paperclipai/db";
import {
  aiConnectionBindingSchema,
  isUsageLimitFallbackStateActive,
  readUsageLimitFallbackConfig,
  readUsageLimitFallbackState,
  type AgentAiHealth,
  type AiConnectionBinding,
  type CompanyAiConnectionHealth,
  type CompanyAiHealth,
} from "@paperclipai/shared";
import { aiConnectionStatus } from "./ai-connections.js";

type ManagedBinding = Extract<AiConnectionBinding, { connectionId: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only shared and delegated bindings name one account; a responsible user's account differs per run. */
function managedBinding(value: unknown): ManagedBinding | null {
  const parsed = aiConnectionBindingSchema.safeParse(value);
  return parsed.success && parsed.data.mode !== "responsible_user" ? parsed.data : null;
}

function modelOf(config: unknown): string | null {
  return isRecord(config) && typeof config.model === "string" && config.model ? config.model : null;
}

/** Company-wide view of broken AI accounts and agents on their fallback. Holds no credential material. */
export function aiHealthService(db: Db) {
  async function summarize(companyId: string, now = new Date()): Promise<CompanyAiHealth> {
    const [agentRows, stateRows, accountRows] = await Promise.all([
      db.select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
        .orderBy(agents.name, agents.id),
      db.select({ agentId: agentRuntimeState.agentId, stateJson: agentRuntimeState.stateJson })
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.companyId, companyId)),
      db.select({ connection: toolConnections, grant: connectionGrants })
        .from(toolConnections)
        .innerJoin(connectionGrants, and(
          eq(connectionGrants.companyId, toolConnections.companyId),
          eq(connectionGrants.connectionId, toolConnections.id),
        ))
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.connectionPurpose, "ai"))),
    ]);
    const stateByAgentId = new Map(stateRows.map((row) => [row.agentId, row.stateJson]));
    const connectionsById = new Map<string, CompanyAiConnectionHealth>();

    function trackConnection(binding: ManagedBinding | null, agentId: string): CompanyAiConnectionHealth | null {
      if (!binding) return null;
      const account = accountRows.find((row) => row.connection.id === binding.connectionId && row.grant.id === binding.grantId);
      if (!account) return null;
      const entry = connectionsById.get(account.connection.id) ?? {
        id: account.connection.id,
        name: account.connection.name,
        provider: binding.provider,
        status: aiConnectionStatus(account.connection, account.grant),
        affectedAgentIds: [],
      };
      if (!entry.affectedAgentIds.includes(agentId)) entry.affectedAgentIds.push(agentId);
      connectionsById.set(entry.id, entry);
      return entry;
    }

    const agentHealth: AgentAiHealth[] = [];
    for (const agent of agentRows) {
      const runtimeConfig = isRecord(agent.runtimeConfig) ? agent.runtimeConfig : {};
      const fallback = readUsageLimitFallbackConfig(runtimeConfig);
      const primaryConnection = trackConnection(managedBinding(runtimeConfig.aiConnection), agent.id);
      const fallbackConnection = fallback ? trackConnection(managedBinding(fallback.aiConnection), agent.id) : null;
      const state = readUsageLimitFallbackState(stateByAgentId.get(agent.id));
      const activeByTime = isUsageLimitFallbackStateActive(state, now);
      const waitForReconnect = Boolean(state?.waitForReconnect && !state.suspendedReason);
      const fallbackActive = Boolean(state) && (activeByTime || waitForReconnect);
      const suspended = fallbackActive && Boolean(state?.suspendedReason);
      const primaryBroken = Boolean(primaryConnection && primaryConnection.status !== "connected");
      const fallbackBroken = Boolean(fallbackConnection && fallbackConnection.status !== "connected");
      const fallbackCanTakeOver = fallback !== null && !fallbackBroken && !suspended
        && (fallbackActive || fallback.switchWhenUnavailable);
      const noWorkingAi = (primaryBroken && !fallbackCanTakeOver) || (suspended && activeByTime);
      if (!fallbackActive && !noWorkingAi) continue;
      agentHealth.push({
        agentId: agent.id,
        lane: fallbackActive && !suspended ? "fallback" : "primary",
        fallbackActive,
        noWorkingAi,
        since: fallbackActive ? state!.activatedAt : null,
        until: fallbackActive ? state!.activeUntil : null,
        waitForReconnect,
        reason: fallbackActive ? state!.reason : null,
        suspendedReason: state?.suspendedReason ?? null,
        primaryAdapterType: agent.adapterType,
        primaryModel: modelOf(agent.adapterConfig),
        primaryConnectionId: primaryConnection?.id ?? null,
        fallbackAdapterType: fallback?.adapterType ?? null,
        fallbackModel: modelOf(fallback?.adapterConfig),
        fallbackConnectionId: fallbackConnection?.id ?? null,
      });
    }
    return { connections: [...connectionsById.values()], agents: agentHealth };
  }
  return { summarize };
}
