import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  isUsageLimitFallbackAdapterType,
  isUsageLimitFallbackStateActive,
  readUsageLimitFallbackState,
  USAGE_LIMIT_FALLBACK_ADAPTER_TYPES,
  usageLimitFallbackPermissionDefaults,
  type UsageLimitFallbackAdapterType,
  type UsageLimitFallbackConfig,
  type UsageLimitFallbackReason,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AiConnectionField } from "./ai-connections/AiConnectionField";
import { Field, ToggleField } from "./agent-config-primitives";
import { ModelDropdown } from "./AgentConfigForm";

const SWITCH_BACK_HINT =
  "Switches back once the primary limit resets. A switched run starts fresh from the task history, comments and documents.";

function defaultFallbackAdapter(primaryAdapterType: string): UsageLimitFallbackAdapterType {
  return USAGE_LIMIT_FALLBACK_ADAPTER_TYPES.find((type) => type !== primaryAdapterType) ?? "codex_local";
}

export function UsageLimitFallbackField({
  companyId,
  agentId,
  agentName,
  primaryAdapterType,
  primaryAdapterConfig = {},
  environmentId,
  value,
  onChange,
}: {
  companyId: string;
  agentId: string;
  agentName: string;
  primaryAdapterType: string;
  primaryAdapterConfig?: Record<string, unknown>;
  environmentId?: string;
  value: UsageLimitFallbackConfig | undefined;
  onChange: (next: UsageLimitFallbackConfig) => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const enabled = value?.enabled === true;
  const fallbackAdapterType = value?.adapterType ?? defaultFallbackAdapter(primaryAdapterType);
  const fallbackModel = typeof value?.adapterConfig?.model === "string" ? value.adapterConfig.model : "";
  const { data: models = [] } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, fallbackAdapterType, environmentId ?? null),
    queryFn: () => agentsApi.adapterModels(companyId, fallbackAdapterType, { environmentId: environmentId ?? null }),
    enabled: enabled,
  });

  if (!isUsageLimitFallbackAdapterType(primaryAdapterType)) {
    if (!enabled || !value) return null;
    // Keep a way to turn off a fallback that the new primary adapter cannot use, or saving would be blocked.
    return (
      <div className="space-y-2 rounded-md border border-destructive/40 px-3 py-2.5" data-testid="usage-limit-fallback">
        <p className="text-xs text-destructive">
          The usage-limit fallback works only with Claude Code and Codex agents. Turn it off to save this adapter.
        </p>
        <ToggleField
          label="Switch when the usage limit is reached"
          checked
          onChange={(next) => onChange({ ...value, enabled: next })}
          toggleTestId="usage-limit-fallback-toggle"
        />
      </div>
    );
  }

  const base: UsageLimitFallbackConfig = value ?? {
    enabled: false,
    adapterType: fallbackAdapterType,
    adapterConfig: {},
    switchBack: "on_reset",
    switchWhenUnavailable: true,
  };
  const primaryLabel = getAdapterDisplay(primaryAdapterType).label;
  const permissionDefaults = usageLimitFallbackPermissionDefaults(primaryAdapterConfig, fallbackAdapterType);
  const switchBackHint = `${primaryLabel} is tried again after 30 minutes, or as soon as its account is reconnected.`;
  // Only the CLI engine reports provider outages; the default ACP engine reports usage limits and sign-in failures.
  const unavailableHint = primaryAdapterConfig.engine === "cli"
    ? `After a second failed try in a row, or a sign-in failure. ${switchBackHint}`
    : `After a sign-in failure. Outages are detected only with the CLI engine, and this agent uses ACP. ${switchBackHint}`;

  return (
    <div className="space-y-3 rounded-md border border-border px-3 py-2.5" data-testid="usage-limit-fallback">
      <ToggleField
        label="Switch when the usage limit is reached"
        hint={SWITCH_BACK_HINT}
        checked={enabled}
        onChange={(next) => onChange({ ...base, enabled: next })}
        toggleTestId="usage-limit-fallback-toggle"
      />
      {enabled && (
        <>
          <ToggleField
            label={`Also switch when ${primaryLabel} is down or signed out`}
            hint={unavailableHint}
            checked={base.switchWhenUnavailable}
            onChange={(next) => onChange({ ...base, switchWhenUnavailable: next })}
            toggleTestId="usage-limit-fallback-when-unavailable"
          />
          <Field label="Fallback adapter">
            <Select
              value={fallbackAdapterType}
              onValueChange={(next) => {
                if (!isUsageLimitFallbackAdapterType(next)) return;
                onChange({ ...base, adapterType: next, adapterConfig: {}, aiConnection: undefined });
              }}
            >
              <SelectTrigger className="w-full" aria-label="Fallback adapter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {USAGE_LIMIT_FALLBACK_ADAPTER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {getAdapterDisplay(type).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <AiConnectionField
            companyId={companyId}
            agentId={agentId}
            agentName={agentName}
            adapterType={fallbackAdapterType}
            model={fallbackModel}
            environmentId={environmentId}
            value={base.aiConnection}
            onChange={(binding) => onChange({ ...base, aiConnection: binding })}
          />
          {fallbackAdapterType === "codex_local" && primaryAdapterType !== "codex_local" && (
            <ToggleField
              label="Bypass Codex approvals and sandbox"
              hint="Matches new Codex agents. Turn off to keep Codex's own approval prompts and sandbox for fallback runs."
              checked={(base.adapterConfig.dangerouslyBypassApprovalsAndSandbox ?? permissionDefaults.dangerouslyBypassApprovalsAndSandbox) !== false}
              onChange={(next) => onChange({ ...base, adapterConfig: { ...base.adapterConfig, dangerouslyBypassApprovalsAndSandbox: next } })}
              toggleTestId="usage-limit-fallback-codex-bypass"
            />
          )}
          {fallbackAdapterType === "claude_local" && primaryAdapterType !== "claude_local" && (
            <ToggleField
              label="Skip Claude permission prompts"
              hint="Matches new Claude Code agents. Turn off to keep Claude's permission checks for fallback runs."
              checked={(base.adapterConfig.dangerouslySkipPermissions ?? permissionDefaults.dangerouslySkipPermissions) !== false}
              onChange={(next) => onChange({ ...base, adapterConfig: { ...base.adapterConfig, dangerouslySkipPermissions: next } })}
              toggleTestId="usage-limit-fallback-claude-skip-permissions"
            />
          )}
          <Field label="Fallback model">
            <ModelDropdown
              models={models}
              value={fallbackModel}
              onChange={(model) => onChange({ ...base, adapterConfig: { ...base.adapterConfig, model: model || undefined } })}
              open={modelOpen}
              onOpenChange={setModelOpen}
              allowDefault
              required={false}
              groupByProvider={false}
            />
          </Field>
        </>
      )}
    </div>
  );
}

function fallbackCause(reason: UsageLimitFallbackReason, primaryLabel: string): string {
  if (reason === "provider_outage") return `${primaryLabel} is not responding`;
  if (reason === "primary_signed_out") return `${primaryLabel} needs to sign in again`;
  return "Usage limit reached";
}

/** Header note shown while the agent runs on its usage-limit fallback. */
export function UsageLimitFallbackStatus({
  stateJson,
  pending,
  onReturnToPrimary,
}: {
  stateJson: Record<string, unknown> | undefined;
  pending: boolean;
  onReturnToPrimary: () => void;
}) {
  const state = readUsageLimitFallbackState(stateJson);
  const waitingForReconnect = state?.waitForReconnect && !state.suspendedReason;
  if (!state || !(waitingForReconnect || isUsageLimitFallbackStateActive(state, new Date()))) return null;
  const until = new Date(state.activeUntil).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const fallbackLabel = getAdapterDisplay(state.fallbackAdapterType).label;
  const primaryLabel = getAdapterDisplay(state.primaryAdapterType).label;
  const cause = fallbackCause(state.reason, primaryLabel);
  return (
    <span className="flex items-center gap-2" data-testid="usage-limit-fallback-status">
      <span>·</span>
      <span className="text-amber-600 dark:text-amber-400">
        {state.suspendedReason
          ? `${cause}: the ${fallbackLabel} fallback cannot run (${state.suspendedReason}), waiting for ${primaryLabel} until ${until}`
          : `${cause}: running on ${fallbackLabel} until ${state.waitForReconnect ? `${primaryLabel} is reconnected` : until}`}
      </span>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={onReturnToPrimary}>
        Return to {primaryLabel}
      </Button>
    </span>
  );
}
