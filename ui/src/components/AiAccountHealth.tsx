import { AlertTriangle, X } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { brandChipBadge } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { useAiHealthDismissal, useCompanyAiHealth } from "../hooks/useCompanyAiHealth";
import { aiConnectionHref, connectionProblem, plural, summarizeAiHealth, type AiHealthProblems } from "../lib/ai-health";

function barMessage({ brokenConnections, affectedAgentCount }: AiHealthProblems): string {
  const agentsLine = brokenConnections.length === 1
    ? `${plural(affectedAgentCount, "agent uses", "agents use")} it.`
    : `${plural(affectedAgentCount, "agent uses", "agents use")} them.`;
  if (brokenConnections.length === 1) {
    const [connection] = brokenConnections;
    return `"${connection!.name}" ${connectionProblem(connection!.status)}. ${agentsLine}`;
  }
  const names = brokenConnections.map((connection) => `"${connection.name}"`).join(", ");
  return `${brokenConnections.length} AI accounts need attention: ${names}. ${agentsLine}`;
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
      <p className="min-w-0 flex-1 font-medium">{barMessage(problems)}</p>
      <div className="flex items-center gap-1">
        <Button asChild size="xs" variant="destructive">
          <Link to={fixHref}>{fixLabel}</Link>
        </Button>
        <Button asChild size="xs" variant="ghost">
          <Link to="/agents/all">Agents</Link>
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Hide AI account warning"
          title="Hide until something new breaks, or for 24 hours"
          onClick={dismiss}
        >
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
        {plural(problems.brokenConnections.length, "AI account needs", "AI accounts need")} attention
      </Badge>
    </button>
  );
}
