import { eq, sql } from "drizzle-orm";
import { agentRuntimeState, type agents, type heartbeatRuns, type Db } from "@paperclipai/db";
import {
  aiConnectionBindingSchema,
  buildUsageLimitFallbackAdapterConfig,
  isUsageLimitFallbackStateActive,
  readUsageLimitFallbackConfig,
  readUsageLimitFallbackState,
  usageLimitFallbackConfigProblem,
  USAGE_LIMIT_FALLBACK_STATE_KEY,
  type UsageLimitFallbackConfig,
  type UsageLimitFallbackLane,
  type UsageLimitFallbackState,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";

/** Same wait recovery uses when a provider gives no reset time. */
export const USAGE_LIMIT_FALLBACK_DEFAULT_WINDOW_MS = 60 * 60 * 1000;

type AgentRow = typeof agents.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;

export type UsageLimitAdapterDispatch = {
  adapterType: string;
  lane?: UsageLimitFallbackLane;
  primaryAdapterType?: string;
  fallbackUntil?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRunAdapterDispatch(run: Pick<RunRow, "runnerProfileJson">): UsageLimitAdapterDispatch | null {
  const profile = isRecord(run.runnerProfileJson) ? run.runnerProfileJson : null;
  const dispatch = profile && isRecord(profile.adapterDispatch) ? profile.adapterDispatch : null;
  if (!dispatch || typeof dispatch.adapterType !== "string") return null;
  return {
    adapterType: dispatch.adapterType,
    ...(dispatch.lane === "fallback" || dispatch.lane === "primary" ? { lane: dispatch.lane } : {}),
    ...(typeof dispatch.primaryAdapterType === "string" ? { primaryAdapterType: dispatch.primaryAdapterType } : {}),
    ...(typeof dispatch.fallbackUntil === "string" ? { fallbackUntil: dispatch.fallbackUntil } : {}),
  };
}

export function runUsageLimitLane(run: Pick<RunRow, "runnerProfileJson">): UsageLimitFallbackLane {
  return readRunAdapterDispatch(run)?.lane === "fallback" ? "fallback" : "primary";
}

/** The agent as a run executes it: on the fallback lane, the fallback adapter, settings and AI connection. */
export function effectiveAgentForRun(agent: AgentRow, run: Pick<RunRow, "runnerProfileJson">): AgentRow {
  if (runUsageLimitLane(run) !== "fallback") return agent;
  const fallback = readUsageLimitFallbackConfig(agent.runtimeConfig);
  if (!fallback) return agent;
  const runtimeConfig: Record<string, unknown> = { ...(isRecord(agent.runtimeConfig) ? agent.runtimeConfig : {}) };
  if (fallback.aiConnection) runtimeConfig.aiConnection = fallback.aiConnection;
  else delete runtimeConfig.aiConnection;
  return {
    ...agent,
    adapterType: fallback.adapterType,
    adapterConfig: buildUsageLimitFallbackAdapterConfig(agent.adapterConfig, fallback),
    runtimeConfig: runtimeConfig as AgentRow["runtimeConfig"],
  };
}

export async function readAgentUsageLimitFallbackState(db: Db, agentId: string): Promise<UsageLimitFallbackState | null> {
  const [row] = await db.select({ stateJson: agentRuntimeState.stateJson }).from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
  return readUsageLimitFallbackState(row?.stateJson);
}

/** Clears the fallback only if it is still the activation the caller saw, so a newer one survives. */
export async function clearUsageLimitFallbackState(db: Db, agentId: string, activatedAt?: string): Promise<void> {
  const matchesActivation = activatedAt
    ? sql`${agentRuntimeState.stateJson} -> ${USAGE_LIMIT_FALLBACK_STATE_KEY} ->> 'activatedAt' = ${activatedAt}`
    : sql`true`;
  await db
    .update(agentRuntimeState)
    .set({ stateJson: sql`${agentRuntimeState.stateJson} - ${USAGE_LIMIT_FALLBACK_STATE_KEY}`, updatedAt: new Date() })
    .where(sql`${agentRuntimeState.agentId} = ${agentId} and ${matchesActivation}`);
}

async function fallbackAiConnectionSelectable(db: Db, agent: AgentRow, fallback: UsageLimitFallbackConfig, responsibleUserId: string | null): Promise<boolean> {
  if (!fallback.aiConnection) return true;
  const effectiveConfig = buildUsageLimitFallbackAdapterConfig(agent.adapterConfig, fallback);
  try {
    await aiConnectionService(db).select({
      companyId: agent.companyId,
      agentId: agent.id,
      userId: responsibleUserId,
      adapterType: fallback.adapterType,
      model: effectiveConfig.model,
      runnerProvider: effectiveConfig.provider,
      acpxAgent: effectiveConfig.acpxAgent,
      binding: fallback.aiConnection,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides the lane when a run is claimed. Expired or unusable fallback state is cleared here,
 * which is the switch-back; the next primary quota failure then waits as it would without a fallback.
 */
export async function resolveAdapterDispatchForClaim(db: Db, agent: AgentRow, run: Pick<RunRow, "responsibleUserId">, now: Date): Promise<UsageLimitAdapterDispatch> {
  const primary = { adapterType: agent.adapterType };
  const state = await readAgentUsageLimitFallbackState(db, agent.id);
  if (!state) return primary;
  const fallback = readUsageLimitFallbackConfig(agent.runtimeConfig);
  const usable = fallback
    && isUsageLimitFallbackStateActive(state, now)
    && state.primaryAdapterType === agent.adapterType
    && state.fallbackAdapterType === fallback.adapterType
    && await fallbackAiConnectionSelectable(db, agent, fallback, run.responsibleUserId ?? null);
  if (!usable) {
    await clearUsageLimitFallbackState(db, agent.id, state.activatedAt);
    return primary;
  }
  return { adapterType: fallback.adapterType, lane: "fallback", primaryAdapterType: agent.adapterType, fallbackUntil: state.activeUntil };
}

export type UsageLimitFallbackActivation =
  | { activated: true; state: UsageLimitFallbackState }
  | { activated: false; reason: string };

/** Turns the fallback on after a primary-lane quota failure, keeping the later end time if one is already active. */
export async function activateUsageLimitFallback(db: Db, input: {
  agent: AgentRow;
  run: RunRow;
  retryNotBefore: Date | null;
  now: Date;
}): Promise<UsageLimitFallbackActivation> {
  const { agent, run, now } = input;
  if (runUsageLimitLane(run) === "fallback") return { activated: false, reason: "already_on_fallback" };
  const fallback = readUsageLimitFallbackConfig(agent.runtimeConfig);
  if (!fallback) return { activated: false, reason: "not_configured" };
  const primaryAiConnection = aiConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection).data;
  const problem = usageLimitFallbackConfigProblem({ primaryAdapterType: agent.adapterType, primaryAiConnection, fallback });
  if (problem) return { activated: false, reason: problem };
  if (!await fallbackAiConnectionSelectable(db, agent, fallback, run.responsibleUserId ?? null)) {
    return { activated: false, reason: "fallback_ai_connection_unavailable" };
  }
  const proposedUntil = input.retryNotBefore && input.retryNotBefore.getTime() > now.getTime()
    ? input.retryNotBefore
    : new Date(now.getTime() + USAGE_LIMIT_FALLBACK_DEFAULT_WINDOW_MS);
  const state = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agent.id)).for("update");
    const current = readUsageLimitFallbackState(row?.stateJson);
    const currentActive = isUsageLimitFallbackStateActive(current, now) ? current : null;
    const keepCurrentEnd = currentActive && Date.parse(currentActive.activeUntil) >= proposedUntil.getTime();
    const next: UsageLimitFallbackState = {
      activeUntil: keepCurrentEnd ? currentActive.activeUntil : proposedUntil.toISOString(),
      activatedAt: currentActive?.activatedAt ?? now.toISOString(),
      sourceRunId: currentActive?.sourceRunId ?? run.id,
      primaryAdapterType: agent.adapterType,
      fallbackAdapterType: fallback.adapterType,
      reason: "provider_quota",
    };
    if (row) {
      await tx.update(agentRuntimeState)
        .set({ stateJson: { ...(isRecord(row.stateJson) ? row.stateJson : {}), [USAGE_LIMIT_FALLBACK_STATE_KEY]: next }, updatedAt: now })
        .where(eq(agentRuntimeState.agentId, agent.id));
    } else {
      await tx.insert(agentRuntimeState).values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: { [USAGE_LIMIT_FALLBACK_STATE_KEY]: next },
      });
    }
    return next;
  });
  return { activated: true, state };
}
