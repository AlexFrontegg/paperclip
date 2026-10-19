import type {
  AgentAiHealth,
  CompanyAiConnectionHealth,
  CompanyAiHealth,
  UsageLimitFallbackReason,
} from "@paperclipai/shared";

export const AI_HEALTH_DISMISS_MS = 24 * 60 * 60 * 1000;
const DISMISSAL_CHANGE_EVENT = "paperclip:ai-health-dismissal";

export function aiConnectionHref(connectionId: string): string {
  return `/apps/${connectionId}/permissions`;
}

/** Why the agent moved to its fallback; names the shared account when it is the one signed out. */
export function fallbackCause(reason: UsageLimitFallbackReason, primaryLabel: string, primaryConnection?: CompanyAiConnectionHealth): string {
  if (reason === "provider_outage") return `${primaryLabel} is not responding`;
  if (reason === "primary_signed_out") {
    return primaryConnection && primaryConnection.status !== "connected"
      ? `"${primaryConnection.name}" ${connectionProblem(primaryConnection.status)}`
      : `${primaryLabel} needs to sign in again`;
  }
  return "Usage limit reached";
}

export function connectionProblem(status: CompanyAiConnectionHealth["status"]): string {
  if (status === "revoked") return "was revoked";
  if (status === "expired") return "has expired";
  return "needs sign-in";
}

export function formatHealthTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export interface AiHealthProblems {
  brokenConnections: CompanyAiConnectionHealth[];
  agentsOnBackup: AgentAiHealth[];
  agentsWithoutAi: AgentAiHealth[];
  signature: string;
}

export function summarizeAiHealth(health: CompanyAiHealth | undefined): AiHealthProblems {
  const brokenConnections = (health?.connections ?? []).filter((connection) => connection.status !== "connected");
  const agentsWithoutAi = (health?.agents ?? []).filter((agent) => agent.noWorkingAi);
  const agentsOnBackup = (health?.agents ?? []).filter((agent) => !agent.noWorkingAi && agent.lane === "fallback");
  const signature = brokenConnections.length || agentsWithoutAi.length
    ? JSON.stringify({
      connections: brokenConnections.map((connection) => `${connection.id}:${connection.status}`).sort(),
      agents: [...agentsOnBackup, ...agentsWithoutAi].map((agent) => `${agent.agentId}:${agent.noWorkingAi ? "none" : "backup"}`).sort(),
    })
    : "";
  return { brokenConnections, agentsOnBackup, agentsWithoutAi, signature };
}

/** Why an agent has no working AI, from its accounts' health. */
export function noWorkingAiReason(agent: AgentAiHealth, connections: CompanyAiConnectionHealth[], primaryLabel: string): string {
  const find = (id: string | null) => connections.find((connection) => connection.id === id);
  const primary = find(agent.primaryConnectionId);
  const fallback = find(agent.fallbackConnectionId);
  const primaryText = primary && primary.status !== "connected"
    ? `"${primary.name}" ${connectionProblem(primary.status)}`
    : agent.reason ? fallbackCause(agent.reason, primaryLabel) : `${primaryLabel} is unavailable`;
  if (!agent.fallbackAdapterType) return `${primaryText}, and it has no backup`;
  if (fallback && fallback.status !== "connected") return `${primaryText}, and its backup, "${fallback.name}", ${connectionProblem(fallback.status)}`;
  if (agent.suspendedReason) return `${primaryText}, and its backup cannot run (${agent.suspendedReason})`;
  return `${primaryText}, and its backup does not switch on a sign-out`;
}

function dismissalKey(companyId: string): string {
  return `paperclip:ai-health-dismissal:${companyId}`;
}

/** Returns when the dismissal of this problem set ends, or null when it is not dismissed. */
export function readAiHealthDismissal(companyId: string, signature: string, now = Date.now()): number | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(dismissalKey(companyId)) ?? "null");
    if (typeof stored !== "object" || stored === null) return null;
    const { signature: storedSignature, dismissedAt } = stored as { signature?: unknown; dismissedAt?: unknown };
    if (storedSignature !== signature || typeof dismissedAt !== "number") return null;
    const hiddenUntil = dismissedAt + AI_HEALTH_DISMISS_MS;
    return hiddenUntil > now ? hiddenUntil : null;
  } catch {
    return null;
  }
}

export function writeAiHealthDismissal(companyId: string, signature: string | null, now = Date.now()): void {
  try {
    if (signature) localStorage.setItem(dismissalKey(companyId), JSON.stringify({ signature, dismissedAt: now }));
    else localStorage.removeItem(dismissalKey(companyId));
  } catch {
    // Storage may be unavailable; the bar then simply stays visible.
  }
  window.dispatchEvent(new Event(DISMISSAL_CHANGE_EVENT));
}

export function subscribeAiHealthDismissal(onChange: () => void): () => void {
  window.addEventListener(DISMISSAL_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DISMISSAL_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
