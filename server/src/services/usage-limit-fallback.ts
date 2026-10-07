import { and, eq, sql } from "drizzle-orm";
import { agentRuntimeState, agentTaskSessions, type agents, type heartbeatRuns, type Db } from "@paperclipai/db";
import {
  aiConnectionBindingSchema,
  buildUsageLimitFallbackAdapterConfig,
  isUsageLimitFallbackStateActive,
  readUsageLimitFallbackConfig,
  readUsageLimitFallbackState,
  usageLimitFallbackConfigProblem,
  USAGE_LIMIT_FALLBACK_STATE_KEY,
  type AiConnectionBinding,
  type UsageLimitFallbackConfig,
  type UsageLimitFallbackLane,
  type UsageLimitFallbackReason,
  type UsageLimitFallbackState,
} from "@paperclipai/shared";
import { AI_AUTH_ENV_KEYS } from "./ai-connection-runtime.js";
import { isAiAuthenticationFailure } from "./ai-auth-failure.js";
import { aiConnectionService } from "./ai-connections.js";

/** Same wait recovery uses when a provider gives no reset time. */
export const USAGE_LIMIT_FALLBACK_DEFAULT_WINDOW_MS = 60 * 60 * 1000;
/** How long an outage or a signed-out primary keeps the fallback before the primary is tried again. */
export const USAGE_LIMIT_FALLBACK_UNAVAILABLE_WINDOW_MS = 30 * 60 * 1000;

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

function fallbackAdapterConfig(agent: AgentRow, fallback: UsageLimitFallbackConfig): Record<string, unknown> {
  const config = buildUsageLimitFallbackAdapterConfig(agent.adapterConfig, fallback, agent.adapterType);
  if (fallback.adapterType === agent.adapterType || !isRecord(config.env)) return config;
  // Another adapter must never pick up the primary's provider credentials, homes or routing.
  const env = { ...config.env };
  for (const key of AI_AUTH_ENV_KEYS) delete env[key];
  return { ...config, env };
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
    adapterConfig: fallbackAdapterConfig(agent, fallback),
    runtimeConfig: runtimeConfig as AgentRow["runtimeConfig"],
  };
}

function fallbackConfigProblem(agent: AgentRow, fallback: UsageLimitFallbackConfig): string | null {
  const primaryAiConnection = aiConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection).data;
  return usageLimitFallbackConfigProblem({ primaryAdapterType: agent.adapterType, primaryAiConnection, fallback });
}

/** Failures of the AI account the run used, as opposed to a problem with the work or a setup gap both lanes share. */
export function isRunAiAccountFailure(run: Pick<RunRow, "errorCode" | "resultJson">): boolean {
  if (run.errorCode !== "configuration_incomplete") return isAiAuthenticationFailure(run.errorCode);
  const resultJson = isRecord(run.resultJson) ? run.resultJson : {};
  const configurationIncomplete = isRecord(resultJson.configurationIncomplete) ? resultJson.configurationIncomplete : {};
  return configurationIncomplete.reason === "ai_connection_unavailable";
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

/** Stops using a fallback that cannot run for the rest of the window, so the agent waits for the primary's reset. */
export async function suspendUsageLimitFallback(db: Db, agentId: string, reason: string, now: Date): Promise<UsageLimitFallbackState | null> {
  const [row] = await db
    .update(agentRuntimeState)
    .set({
      stateJson: sql`jsonb_set(${agentRuntimeState.stateJson}, ${`{${USAGE_LIMIT_FALLBACK_STATE_KEY},suspendedReason}`}::text[], ${JSON.stringify(reason)}::jsonb)`,
      updatedAt: now,
    })
    .where(sql`${agentRuntimeState.agentId} = ${agentId} and (${agentRuntimeState.stateJson} -> ${USAGE_LIMIT_FALLBACK_STATE_KEY} ->> 'activeUntil')::timestamptz > ${now.toISOString()}::timestamptz`)
    .returning({ stateJson: agentRuntimeState.stateJson });
  return readUsageLimitFallbackState(row?.stateJson);
}

async function aiAccountSelectable(db: Db, agent: AgentRow, account: {
  adapterType: string;
  config: Record<string, unknown>;
  binding: AiConnectionBinding;
  responsibleUserId: string | null;
}): Promise<boolean> {
  try {
    await aiConnectionService(db).select({
      companyId: agent.companyId,
      agentId: agent.id,
      userId: account.responsibleUserId,
      adapterType: account.adapterType,
      model: account.config.model,
      runnerProvider: account.config.provider,
      acpxAgent: account.config.acpxAgent,
      binding: account.binding,
    });
    return true;
  } catch {
    return false;
  }
}

async function fallbackAiConnectionSelectable(db: Db, agent: AgentRow, fallback: UsageLimitFallbackConfig, responsibleUserId: string | null): Promise<boolean> {
  if (!fallback.aiConnection) return true;
  return aiAccountSelectable(db, agent, {
    adapterType: fallback.adapterType,
    config: fallbackAdapterConfig(agent, fallback),
    binding: fallback.aiConnection,
    responsibleUserId,
  });
}

/** Whether the primary's managed AI account still cannot be used; null when there is no managed account to check. */
async function primaryAccountSignedOut(db: Db, agent: AgentRow, responsibleUserId: string | null): Promise<boolean | null> {
  const binding = aiConnectionBindingSchema.safeParse((agent.runtimeConfig as Record<string, unknown> | null)?.aiConnection).data;
  if (!binding) return null;
  const config = isRecord(agent.adapterConfig) ? agent.adapterConfig : {};
  return !await aiAccountSelectable(db, agent, { adapterType: agent.adapterType, config, binding, responsibleUserId });
}

async function extendUsageLimitFallback(db: Db, agentId: string, activatedAt: string, until: Date): Promise<void> {
  await db
    .update(agentRuntimeState)
    .set({
      stateJson: sql`jsonb_set(${agentRuntimeState.stateJson}, ${`{${USAGE_LIMIT_FALLBACK_STATE_KEY},activeUntil}`}::text[], ${JSON.stringify(until.toISOString())}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(sql`${agentRuntimeState.agentId} = ${agentId}
      and ${agentRuntimeState.stateJson} -> ${USAGE_LIMIT_FALLBACK_STATE_KEY} ->> 'activatedAt' = ${activatedAt}
      and (${agentRuntimeState.stateJson} -> ${USAGE_LIMIT_FALLBACK_STATE_KEY} ->> 'activeUntil')::timestamptz < ${until.toISOString()}::timestamptz`);
}

/**
 * Decides the lane when a run is claimed. An expired state or a changed config is cleared here,
 * which is the switch-back. A suspended fallback, or one this run's responsible user cannot use,
 * sends only this run to the primary and leaves the agent's fallback in place.
 */
export async function resolveAdapterDispatchForClaim(db: Db, agent: AgentRow, run: Pick<RunRow, "responsibleUserId">, now: Date): Promise<UsageLimitAdapterDispatch> {
  const primary = { adapterType: agent.adapterType };
  const state = await readAgentUsageLimitFallbackState(db, agent.id);
  if (!state) return primary;
  const fallback = readUsageLimitFallbackConfig(agent.runtimeConfig);
  const sameSetup = fallback !== null
    && !fallbackConfigProblem(agent, fallback)
    && state.primaryAdapterType === agent.adapterType
    && state.fallbackAdapterType === fallback.adapterType;
  // A managed primary account that is still signed out keeps the fallback past its window; a reconnected one ends it early.
  const primarySignedOut = sameSetup && state.waitForReconnect
    ? await primaryAccountSignedOut(db, agent, run.responsibleUserId ?? null)
    : null;
  if (!fallback || !sameSetup || !(primarySignedOut ?? isUsageLimitFallbackStateActive(state, now))) {
    await clearUsageLimitFallbackState(db, agent.id, state.activatedAt);
    return primary;
  }
  let fallbackUntil = state.activeUntil;
  if (primarySignedOut) {
    const checkAgainAt = new Date(now.getTime() + USAGE_LIMIT_FALLBACK_UNAVAILABLE_WINDOW_MS);
    if (Date.parse(fallbackUntil) < checkAgainAt.getTime()) {
      await extendUsageLimitFallback(db, agent.id, state.activatedAt, checkAgainAt);
      fallbackUntil = checkAgainAt.toISOString();
    }
  }
  if (state.suspendedReason) return primary;
  if (!await fallbackAiConnectionSelectable(db, agent, fallback, run.responsibleUserId ?? null)) return primary;
  return { adapterType: fallback.adapterType, lane: "fallback", primaryAdapterType: agent.adapterType, fallbackUntil };
}

export type UsageLimitFallbackActivation =
  | { activated: true; state: UsageLimitFallbackState }
  | { activated: false; reason: string };

/**
 * Turns the fallback on after a primary-lane failure: a usage limit, or, when the fallback is set to
 * also switch on it, an outage or a signed-out account. A later end time already active is kept.
 */
export async function activateUsageLimitFallback(db: Db, input: {
  agent: AgentRow;
  run: RunRow;
  reason?: UsageLimitFallbackReason;
  retryNotBefore: Date | null;
  now: Date;
}): Promise<UsageLimitFallbackActivation> {
  const { agent, run, now } = input;
  const reason = input.reason ?? "provider_quota";
  if (runUsageLimitLane(run) === "fallback") return { activated: false, reason: "already_on_fallback" };
  const fallback = readUsageLimitFallbackConfig(agent.runtimeConfig);
  if (!fallback || (reason !== "provider_quota" && !fallback.switchWhenUnavailable)) return { activated: false, reason: "not_configured" };
  const problem = fallbackConfigProblem(agent, fallback);
  if (problem) return { activated: false, reason: problem };
  const existing = await readAgentUsageLimitFallbackState(db, agent.id);
  if (existing?.suspendedReason && isUsageLimitFallbackStateActive(existing, now)) {
    return { activated: false, reason: `fallback_suspended:${existing.suspendedReason}` };
  }
  if (!await fallbackAiConnectionSelectable(db, agent, fallback, run.responsibleUserId ?? null)) {
    return { activated: false, reason: "fallback_ai_connection_unavailable" };
  }
  // Only an account marked signed out can be watched for a reconnect; otherwise the primary is retried on a timer.
  const waitForReconnect = reason === "primary_signed_out"
    && await primaryAccountSignedOut(db, agent, run.responsibleUserId ?? null) === true;
  const windowMs = reason === "provider_quota" ? USAGE_LIMIT_FALLBACK_DEFAULT_WINDOW_MS : USAGE_LIMIT_FALLBACK_UNAVAILABLE_WINDOW_MS;
  const proposedUntil = input.retryNotBefore && input.retryNotBefore.getTime() > now.getTime()
    ? input.retryNotBefore
    : new Date(now.getTime() + windowMs);
  const state = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agent.id)).for("update");
    const current = readUsageLimitFallbackState(row?.stateJson);
    const currentActive = isUsageLimitFallbackStateActive(current, now) ? current : null;
    if (currentActive?.suspendedReason) return null;
    const keepCurrentEnd = currentActive && Date.parse(currentActive.activeUntil) >= proposedUntil.getTime();
    const next: UsageLimitFallbackState = {
      activeUntil: keepCurrentEnd ? currentActive.activeUntil : proposedUntil.toISOString(),
      activatedAt: currentActive?.activatedAt ?? now.toISOString(),
      sourceRunId: currentActive?.sourceRunId ?? run.id,
      primaryAdapterType: agent.adapterType,
      fallbackAdapterType: fallback.adapterType,
      reason: keepCurrentEnd ? currentActive.reason : reason,
      ...(waitForReconnect || (keepCurrentEnd && currentActive.waitForReconnect) ? { waitForReconnect: true } : {}),
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
    if (!currentActive && fallback.adapterType !== agent.adapterType) {
      // A new window starts the fallback fresh; its sessions from an earlier window miss the primary's turns since.
      await tx.delete(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, agent.companyId),
        eq(agentTaskSessions.agentId, agent.id),
        eq(agentTaskSessions.adapterType, fallback.adapterType),
      ));
    }
    return next;
  });
  if (!state) return { activated: false, reason: "fallback_suspended" };
  return { activated: true, state };
}
