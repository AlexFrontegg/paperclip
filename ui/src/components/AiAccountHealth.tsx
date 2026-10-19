import { AlertTriangle, X } from "lucide-react";
import type { AgentAiHealth, CompanyAiConnectionHealth } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { brandChipBadge } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { useAgentAiHealth, useAiHealthDismissal, useCompanyAiHealth } from "../hooks/useCompanyAiHealth";
import {
  aiConnectionHref,
  connectionProblem,
  fallbackCause,
  formatHealthTime,
  noWorkingAiReason,
  plural,
  summarizeAiHealth,
  type AiHealthProblems,
} from "../lib/ai-health";

const HIDE_HINT = "Hide until something new breaks, or for 24 hours";

function barHeadline({ brokenConnections, agentsWithoutAi }: AiHealthProblems): string {
  if (brokenConnections.length === 1) {
    const [connection] = brokenConnections;
    return `"${connection!.name}" ${connectionProblem(connection!.status)}.`;
  }
  if (brokenConnections.length > 1) {
    return `${brokenConnections.length} AI accounts need attention: ${brokenConnections.map((connection) => `"${connection.name}"`).join(", ")}.`;
  }
  return `${plural(agentsWithoutAi.length, "agent has", "agents have")} no working AI.`;
}

function barDetail({ brokenConnections, agentsOnBackup, agentsWithoutAi }: AiHealthProblems): string {
  const parts: string[] = [];
  if (agentsOnBackup.length) parts.push(`${plural(agentsOnBackup.length, "agent is", "agents are")} running on their backup.`);
  if (agentsWithoutAi.length && brokenConnections.length) parts.push(`${plural(agentsWithoutAi.length, "agent has", "agents have")} no working AI.`);
  return parts.join(" ");
}

function pillLabel({ brokenConnections, agentsWithoutAi }: AiHealthProblems): string {
  if (brokenConnections.length) return `${plural(brokenConnections.length, "AI account needs", "AI accounts need")} attention`;
  return `${plural(agentsWithoutAi.length, "agent has", "agents have")} no working AI`;
}

/** Company-wide warning shown on every board page while an AI account that agents use is broken. */
export function AiAccountHealthBar() {
  const { data } = useCompanyAiHealth();
  const problems = summarizeAiHealth(data);
  const { dismissed, dismiss } = useAiHealthDismissal(problems.signature);
  if (!problems.signature || dismissed) return null;
  const [onlyConnection] = problems.brokenConnections.length === 1 ? problems.brokenConnections : [];
  const fixHref = onlyConnection ? aiConnectionHref(onlyConnection.id) : "/apps";
  const fixLabel = !onlyConnection ? "Open AI accounts" : onlyConnection.status === "revoked" ? "Open account" : "Sign in";
  return (
    <div
      role="alert"
      data-testid="ai-account-health-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-red-300/60 bg-red-50 px-3 py-2 text-sm text-red-950 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-100"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{barHeadline(problems)}</span> {barDetail(problems)}
      </p>
      <div className="flex items-center gap-1">
        <Button asChild size="xs" variant="destructive">
          <Link to={fixHref}>{fixLabel}</Link>
        </Button>
        <Button asChild size="xs" variant="ghost">
          <Link to="/agents/all">Details</Link>
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Hide AI account warning" title={HIDE_HINT} onClick={dismiss}>
          <X />
        </Button>
      </div>
    </div>
  );
}

/** Reminder in the top bar while the warning is hidden; it reopens the warning. */
export function AiAccountHealthPill() {
  const { data } = useCompanyAiHealth();
  const problems = summarizeAiHealth(data);
  const { dismissed, reopen } = useAiHealthDismissal(problems.signature);
  if (!problems.signature || !dismissed) return null;
  return (
    <button type="button" onClick={reopen} title="Show the AI account warning" data-testid="ai-account-health-pill">
      <Badge variant="outline" className={cn(brandChipBadge.red, "cursor-pointer")}>
        <AlertTriangle />
        {pillLabel(problems)}
      </Badge>
    </button>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="opacity-70">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function modelLabel(adapterType: string, model: string | null): string {
  return [getAdapterDisplay(adapterType).label, model].filter(Boolean).join(" ");
}

function AgentAiHealthDetails({ health, connections }: { health: AgentAiHealth; connections: CompanyAiConnectionHealth[] }) {
  const primaryLabel = getAdapterDisplay(health.primaryAdapterType).label;
  const onFallback = health.lane === "fallback" && health.fallbackAdapterType;
  const why = health.noWorkingAi
    ? noWorkingAiReason(health, connections, primaryLabel)
    : health.reason ? fallbackCause(health.reason, primaryLabel, connections.find((connection) => connection.id === health.primaryConnectionId)) : null;
  const returns = health.waitForReconnect
    ? `when ${primaryLabel} is signed in`
    : health.until ? formatHealthTime(health.until) : null;
  return (
    <div className="w-64 space-y-0.5 text-left">
      <p className="mb-1 font-semibold">{health.noWorkingAi ? "No working AI" : "Running on its backup model"}</p>
      <TooltipRow label="Usual model" value={modelLabel(health.primaryAdapterType, health.primaryModel)} />
      {onFallback ? <TooltipRow label="Now" value={modelLabel(onFallback, health.fallbackModel)} /> : null}
      {health.since ? <TooltipRow label="Since" value={formatHealthTime(health.since)} /> : null}
      {why ? <TooltipRow label="Why" value={why} /> : null}
      {returns && !health.noWorkingAi ? <TooltipRow label="Returns" value={returns} /> : null}
    </div>
  );
}

/** "Backup" or "No AI" next to an agent, with the details on hover. */
export function AgentAiHealthBadge({ agentId, className }: { agentId: string; className?: string }) {
  const { agentHealth, connections } = useAgentAiHealth(agentId);
  if (!agentHealth || !(agentHealth.noWorkingAi || agentHealth.lane === "fallback")) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          data-testid="agent-ai-health-badge"
          className={cn(agentHealth.noWorkingAi ? brandChipBadge.red : brandChipBadge.amber, "px-1.5 py-0 text-(length:--text-nano)", className)}
        >
          {agentHealth.noWorkingAi ? "No AI" : "Backup"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right">
        <AgentAiHealthDetails health={agentHealth} connections={connections} />
      </TooltipContent>
    </Tooltip>
  );
}
