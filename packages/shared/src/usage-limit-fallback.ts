import { z } from "zod";
import { aiConnectionBindingSchema, type AiConnectionBinding } from "./ai-connections.js";

export const USAGE_LIMIT_FALLBACK_ADAPTER_TYPES = ["claude_local", "codex_local"] as const;
export type UsageLimitFallbackAdapterType = (typeof USAGE_LIMIT_FALLBACK_ADAPTER_TYPES)[number];
export type UsageLimitFallbackLane = "primary" | "fallback";

// Settings a fallback on another adapter inherits so the agent keeps its instructions, skills, workspace and confinement.
export const USAGE_LIMIT_FALLBACK_INHERITED_CONFIG_KEYS = [
  "cwd",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "paperclipSkillSync",
  "env",
  "engine",
  "mode",
  "nonInteractivePermissions",
  "warmHandleIdleMs",
  "workspaceStrategy",
  "workspaceRuntime",
  "filesystemScope",
  "filesystemExtraPaths",
  "filesystemSandboxCommand",
  "networkScope",
  "networkAllowlist",
  "timeoutSec",
  "graceSec",
] as const;

// Only engine-specific settings: paths, commands, env and workspace settings always come from the primary.
const fallbackAdapterConfigSchema = z.object({
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  modelReasoningEffort: z.string().trim().min(1).optional(),
  fastMode: z.boolean().optional(),
  search: z.boolean().optional(),
  chrome: z.boolean().optional(),
  maxTurnsPerRun: z.number().int().min(0).optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
  networkAllowlist: z.array(z.string().trim().min(1)).optional(),
}).strict();

export const usageLimitFallbackConfigSchema = z.object({
  enabled: z.boolean(),
  adapterType: z.enum(USAGE_LIMIT_FALLBACK_ADAPTER_TYPES),
  adapterConfig: fallbackAdapterConfigSchema.default({}),
  aiConnection: aiConnectionBindingSchema.optional(),
  switchBack: z.literal("on_reset").default("on_reset"),
  /** Also switch when the primary's provider is down or its account is signed out, not only on a usage limit. */
  switchWhenUnavailable: z.boolean().default(false),
}).strict();

export type UsageLimitFallbackConfig = z.infer<typeof usageLimitFallbackConfigSchema>;

export const USAGE_LIMIT_FALLBACK_REASONS = ["provider_quota", "provider_outage", "primary_signed_out"] as const;
export type UsageLimitFallbackReason = (typeof USAGE_LIMIT_FALLBACK_REASONS)[number];

export const usageLimitFallbackStateSchema = z.object({
  activeUntil: z.string().datetime(),
  activatedAt: z.string().datetime(),
  sourceRunId: z.string().min(1),
  primaryAdapterType: z.string().min(1),
  fallbackAdapterType: z.string().min(1),
  reason: z.enum(USAGE_LIMIT_FALLBACK_REASONS),
  /** Set when the primary's shared or delegated account is signed out; the fallback then lasts until it is reconnected. */
  waitForReconnect: z.boolean().optional(),
  /** Set when the fallback itself cannot run; the agent then waits for the primary's reset. */
  suspendedReason: z.string().min(1).optional(),
});

export type UsageLimitFallbackState = z.infer<typeof usageLimitFallbackStateSchema>;

export const USAGE_LIMIT_FALLBACK_STATE_KEY = "usageLimitFallback";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUsageLimitFallbackAdapterType(value: unknown): value is UsageLimitFallbackAdapterType {
  return typeof value === "string" && (USAGE_LIMIT_FALLBACK_ADAPTER_TYPES as readonly string[]).includes(value);
}

/** Returns the enabled fallback config, or null when it is absent, disabled or invalid. */
export function readUsageLimitFallbackConfig(runtimeConfig: unknown): UsageLimitFallbackConfig | null {
  if (!isRecord(runtimeConfig) || runtimeConfig.usageLimitFallback === undefined) return null;
  const parsed = usageLimitFallbackConfigSchema.safeParse(runtimeConfig.usageLimitFallback);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

export function readUsageLimitFallbackState(stateJson: unknown): UsageLimitFallbackState | null {
  if (!isRecord(stateJson)) return null;
  const parsed = usageLimitFallbackStateSchema.safeParse(stateJson[USAGE_LIMIT_FALLBACK_STATE_KEY]);
  return parsed.success ? parsed.data : null;
}

export function isUsageLimitFallbackStateActive(state: UsageLimitFallbackState | null, now: Date): boolean {
  if (!state) return false;
  const activeUntil = Date.parse(state.activeUntil);
  return Number.isFinite(activeUntil) && activeUntil > now.getTime();
}

/** A fallback on the same adapter keeps every primary setting; one on another adapter keeps only the shared ones. */
export function buildUsageLimitFallbackAdapterConfig(
  primaryAdapterConfig: unknown,
  fallback: Pick<UsageLimitFallbackConfig, "adapterType" | "adapterConfig">,
  primaryAdapterType: string,
): Record<string, unknown> {
  const primary = isRecord(primaryAdapterConfig) ? primaryAdapterConfig : {};
  if (fallback.adapterType === primaryAdapterType) {
    // The primary's sandbox and permission settings always apply to a second account on its adapter.
    const { dangerouslySkipPermissions, dangerouslyBypassApprovalsAndSandbox, ...engineSettings } = fallback.adapterConfig;
    return { ...primary, ...engineSettings };
  }
  const inherited: Record<string, unknown> = {};
  for (const key of USAGE_LIMIT_FALLBACK_INHERITED_CONFIG_KEYS) {
    if (primary[key] !== undefined) inherited[key] = primary[key];
  }
  return { ...inherited, ...fallback.adapterConfig };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Compares JSON values regardless of object key order, since jsonb does not preserve it. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

export function sameAiConnectionBinding(left: AiConnectionBinding | undefined, right: AiConnectionBinding | undefined): boolean {
  return sameJsonValue(left, right);
}

/** Explains why a fallback cannot be used with this primary, or returns null when it can. */
export function usageLimitFallbackConfigProblem(input: {
  primaryAdapterType: string;
  primaryAiConnection?: AiConnectionBinding;
  fallback: UsageLimitFallbackConfig;
}): string | null {
  if (!isUsageLimitFallbackAdapterType(input.primaryAdapterType)) {
    return `Usage-limit fallback is supported only for ${USAGE_LIMIT_FALLBACK_ADAPTER_TYPES.join(" and ")} agents`;
  }
  if (input.fallback.adapterType === input.primaryAdapterType && sameAiConnectionBinding(input.fallback.aiConnection, input.primaryAiConnection)) {
    return "The fallback must use a different adapter or a different AI account than the primary";
  }
  if (input.primaryAiConnection && !input.fallback.aiConnection) {
    return "Choose an AI account for the fallback: an agent on a managed AI account cannot fall back to host or legacy credentials";
  }
  return null;
}
