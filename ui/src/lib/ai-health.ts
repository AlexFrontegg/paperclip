import { AI_CONNECTION_CAPABILITIES } from "@paperclipai/shared";
import type {
  AgentAiHealth,
  CompanyAiConnectionHealth,
  CompanyAiHealth,
  UsageLimitFallbackReason,
} from "@paperclipai/shared";

export const AI_HEALTH_DISMISS_MS = 24 * 60 * 60 * 1000;
const DISMISSAL_CHANGE_EVENT = "paperclip:ai-health-dismissal";

/** Where a person signs the account in again; a deleted account has no page, so the accounts list. */
export function aiConnectionHref(connection: CompanyAiConnectionHealth): string {
  return connection.status === "missing" ? "/apps" : `/apps/${connection.id}/permissions`;
}

export function connectionLabel(connection: CompanyAiConnectionHealth): string {
  if (connection.name) return `"${connection.name}"`;
  const providerName = AI_CONNECTION_CAPABILITIES[connection.provider].name;
  return `${/^[AEIOU]/.test(providerName) ? "an" : "a"} ${providerName} account`;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function connectionProblem(status: CompanyAiConnectionHealth["status"]): string {
  if (status === "revoked") return "was revoked";
  if (status === "expired") return "has expired";
  if (status === "missing") return "was deleted";
  return "needs sign-in";
}

export function describeConnectionProblem(connection: CompanyAiConnectionHealth): string {
  return `${connectionLabel(connection)} ${connectionProblem(connection.status)}`;
}

export function findConnection(connections: CompanyAiConnectionHealth[], key: string | null): CompanyAiConnectionHealth | undefined {
  return key ? connections.find((connection) => connection.key === key) : undefined;
}

function isBroken(connection: CompanyAiConnectionHealth | undefined): connection is CompanyAiConnectionHealth {
  return Boolean(connection && connection.status !== "connected");
}

/** Why the agent moved to its fallback; names the shared account when it is the one signed out. */
export function fallbackCause(reason: UsageLimitFallbackReason, primaryLabel: string, primaryConnection?: CompanyAiConnectionHealth): string {
  if (reason === "provider_outage") return `${primaryLabel} is not responding`;
  if (reason === "primary_signed_out") {
    return isBroken(primaryConnection) ? capitalize(describeConnectionProblem(primaryConnection)) : `${primaryLabel} needs to sign in again`;
  }
  return "Usage limit reached";
}

export function formatHealthTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** An agent whose own AI works but whose backup account is broken. */
export function hasBrokenBackup(agent: AgentAiHealth): boolean {
  return !agent.noWorkingAi && agent.lane === "primary" && agent.backupIssue === "account";
}

export interface AiHealthProblems {
  brokenConnections: CompanyAiConnectionHealth[];
  agentsOnBackup: AgentAiHealth[];
  agentsWithoutAi: AgentAiHealth[];
  agentsWithBrokenBackup: AgentAiHealth[];
  signature: string;
}

export function summarizeAiHealth(health: CompanyAiHealth | undefined): AiHealthProblems {
  const agents = health?.agents ?? [];
  const brokenConnections = (health?.connections ?? []).filter(isBroken);
  const agentsWithoutAi = agents.filter((agent) => agent.noWorkingAi);
  const agentsOnBackup = agents.filter((agent) => !agent.noWorkingAi && agent.lane === "fallback");
  const agentsWithBrokenBackup = agents.filter(hasBrokenBackup);
  const agentStates = [
    ...agentsOnBackup.map((agent) => `${agent.agentId}:backup`),
    ...agentsWithoutAi.map((agent) => `${agent.agentId}:none`),
    ...agentsWithBrokenBackup.map((agent) => `${agent.agentId}:backup-broken`),
  ];
  const signature = brokenConnections.length || agentsWithoutAi.length || agentsOnBackup.length
    ? JSON.stringify({
      connections: brokenConnections.map((connection) => `${connection.id}:${connection.status}`).sort(),
      agents: agentStates.sort(),
    })
    : "";
  return { brokenConnections, agentsOnBackup, agentsWithoutAi, agentsWithBrokenBackup, signature };
}

function backupProblem(agent: AgentAiHealth, connections: CompanyAiConnectionHealth[]): string {
  const fallback = findConnection(connections, agent.fallbackConnectionKey);
  if (agent.backupIssue === "account" && fallback) return `its backup, ${connectionLabel(fallback)}, ${connectionProblem(fallback.status)}`;
  if (agent.backupIssue === "usage_limit") return "its backup hit its usage limit too";
  if (agent.backupIssue === "suspended") return `its backup cannot run (${agent.suspendedReason})`;
  if (agent.backupIssue === "not_configured") return "it has no backup";
  if (agent.backupIssue === "no_switch") return "its backup does not switch on a sign-out";
  return "its backup cannot run";
}

/** Why an agent has no working AI, from its accounts' health. */
export function noWorkingAiReason(agent: AgentAiHealth, connections: CompanyAiConnectionHealth[], primaryLabel: string): string {
  const primary = findConnection(connections, agent.primaryConnectionKey);
  const primaryText = isBroken(primary)
    ? describeConnectionProblem(primary)
    : agent.reason ? fallbackCause(agent.reason, primaryLabel) : `${primaryLabel} is unavailable`;
  return capitalize(`${primaryText}, and ${backupProblem(agent, connections)}`);
}

function dismissalKey(companyId: string): string {
  return `paperclip:ai-health-dismissal:${companyId}`;
}

function readStoredDismissal(companyId: string): { signature?: unknown; dismissedAt?: unknown } | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(dismissalKey(companyId)) ?? "null");
    return typeof stored === "object" && stored !== null ? stored : null;
  } catch {
    return null;
  }
}

/** Returns when the dismissal of this problem set ends, or null when it is not dismissed. */
export function readAiHealthDismissal(companyId: string, signature: string, now = Date.now()): number | null {
  const stored = readStoredDismissal(companyId);
  if (!stored || stored.signature !== signature || typeof stored.dismissedAt !== "number") return null;
  const hiddenUntil = stored.dismissedAt + AI_HEALTH_DISMISS_MS;
  return hiddenUntil > now ? hiddenUntil : null;
}

/** A dismissal belongs to one problem set; once the problems change, even to none, it no longer applies. */
export function forgetOutdatedAiHealthDismissal(companyId: string, currentSignature: string): void {
  const stored = readStoredDismissal(companyId);
  if (stored && stored.signature !== currentSignature) writeAiHealthDismissal(companyId, null);
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
