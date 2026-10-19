import { AlertTriangle, X } from "lucide-react";
import type { AgentAiHealth, CompanyAiConnectionHealth } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { brandBanner, brandChipBadge } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { useAgentAiHealth, useAiHealthDismissal, useCompanyAiHealth } from "../hooks/useCompanyAiHealth";
import {
  aiConnectionHref,
  capitalize,
  connectionLabel,
  describeConnectionProblem,
  fallbackCause,
  findConnection,
  hasBrokenBackup,
  formatHealthTime,
  noWorkingAiReason,
  plural,
  summarizeAiHealth,
  type AiHealthProblems,
} from "../lib/ai-health";

const HIDE_HINT = "Hide until something new breaks, or for 24 hours";
const STRIP_CLASS = "flex flex-wrap items-center gap-x-3 gap-y-2 border-0 border-b px-3 py-2 text-sm";

function barHeadline({ brokenConnections, agentsWithoutAi }: AiHealthProblems): string {
  if (brokenConnections.length === 1) return `${capitalize(describeConnectionProblem(brokenConnections[0]!))}.`;
  if (brokenConnections.length > 1) {
    return `${brokenConnections.length} AI accounts need attention: ${brokenConnections.map(connectionLabel).join(", ")}.`;
  }
  return `${plural(agentsWithoutAi.length, "agent has", "agents have")} no working AI.`;
}

function barDetail({ brokenConnections, agentsOnBackup, agentsWithoutAi, agentsWithBrokenBackup }: AiHealthProblems): string {
  const parts: string[] = [];
  if (agentsOnBackup.length) parts.push(`${plural(agentsOnBackup.length, "agent is", "agents are")} running on their backup.`);
  if (agentsWithoutAi.length && brokenConnections.length) parts.push(`${plural(agentsWithoutAi.length, "agent has", "agents have")} no working AI.`);
  if (agentsWithBrokenBackup.length) parts.push(`${plural(agentsWithBrokenBackup.length, "agent has", "agents have")} no working backup.`);
  return parts.join(" ");
}

function pillLabel({ brokenConnections, agentsWithoutAi }: AiHealthProblems): string {
  if (brokenConnections.length) return `${plural(brokenConnections.length, "AI account needs", "AI accounts need")} attention`;
  return `${plural(agentsWithoutAi.length, "agent has", "agents have")} no working AI`;
}

/** Company-wide warning shown on every board page while an AI account that agents use is broken. */
export function AiAccountHealthBar() {
  const { data, isSuccess, isError, isFetching, refetch } = useCompanyAiHealth();
  const problems = summarizeAiHealth(data);
  const { dismissed, dismiss } = useAiHealthDismissal(problems.signature, isSuccess);
  const failure = isError ? (
    <div
      role="alert"
      data-testid="ai-account-health-error"
      className={cn(STRIP_CLASS, brandBanner.warning)}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">Could not check the AI accounts agents use.</p>
      <Button size="xs" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
        Retry
      </Button>
    </div>
  ) : null;
  if (!problems.signature || dismissed) return failure;
  const [onlyConnection] = problems.brokenConnections.length === 1 ? problems.brokenConnections : [];
  const fixHref = onlyConnection ? aiConnectionHref(onlyConnection) : "/apps";
  const fixLabel = onlyConnection && (onlyConnection.status === "needs_attention" || onlyConnection.status === "expired")
    ? "Sign in"
    : onlyConnection?.status === "revoked" ? "Open account" : "Open AI accounts";
  return (
    <>
      {failure}
      <div
        role="alert"
        data-testid="ai-account-health-bar"
        className={cn(STRIP_CLASS, brandBanner.danger)}
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
    </>
  );
}

/** Reminder in the top bar while the warning is hidden; it reopens the warning. */
export function AiAccountHealthPill() {
  const { data, isSuccess } = useCompanyAiHealth();
  const problems = summarizeAiHealth(data);
  const { dismissed, reopen } = useAiHealthDismissal(problems.signature, isSuccess);
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

function badgeTitle(health: AgentAiHealth): string {
  if (health.noWorkingAi) return "No working AI";
  if (hasBrokenBackup(health)) return "Its backup cannot take over";
  return "Running on its backup model";
}

function AgentAiHealthDetails({ health, connections }: { health: AgentAiHealth; connections: CompanyAiConnectionHealth[] }) {
  const primaryLabel = getAdapterDisplay(health.primaryAdapterType).label;
  const onFallback = health.lane === "fallback" && health.fallbackAdapterType;
  const backup = findConnection(connections, health.fallbackConnectionKey);
  const why = health.noWorkingAi
    ? noWorkingAiReason(health, connections, primaryLabel)
    : hasBrokenBackup(health) && backup
      ? `Backup ${describeConnectionProblem(backup)}`
      : health.reason ? fallbackCause(health.reason, primaryLabel, findConnection(connections, health.primaryConnectionKey)) : null;
  const returns = health.waitForReconnect
    ? `when ${primaryLabel} is signed in`
    : health.until ? formatHealthTime(health.until) : null;
  return (
    <div className="w-64 space-y-0.5 text-left">
      <p className="mb-1 font-semibold">{badgeTitle(health)}</p>
      <TooltipRow label="Usual model" value={modelLabel(health.primaryAdapterType, health.primaryModel)} />
      {onFallback ? <TooltipRow label="Now" value={modelLabel(onFallback, health.fallbackModel)} /> : null}
      {!onFallback && health.fallbackAdapterType ? <TooltipRow label="Backup" value={modelLabel(health.fallbackAdapterType, health.fallbackModel)} /> : null}
      {health.since ? <TooltipRow label="Since" value={formatHealthTime(health.since)} /> : null}
      {why ? <TooltipRow label="Why" value={why} /> : null}
      {returns && health.fallbackActive && !health.noWorkingAi ? <TooltipRow label="Returns" value={returns} /> : null}
    </div>
  );
}

/** "Backup", "Backup broken" or "No AI" next to an agent, with the details on hover. */
export function AgentAiHealthBadge({ agentId, className }: { agentId: string; className?: string }) {
  const { agentHealth, connections } = useAgentAiHealth(agentId);
  if (!agentHealth) return null;
  const label = agentHealth.noWorkingAi
    ? "No AI"
    : agentHealth.lane === "fallback" ? "Backup" : hasBrokenBackup(agentHealth) ? "Backup broken" : null;
  if (!label) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          data-testid="agent-ai-health-badge"
          className={cn(agentHealth.noWorkingAi ? brandChipBadge.red : brandChipBadge.amber, "px-1.5 py-0 text-(length:--text-nano)", className)}
        >
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right">
        <AgentAiHealthDetails health={agentHealth} connections={connections} />
      </TooltipContent>
    </Tooltip>
  );
}
