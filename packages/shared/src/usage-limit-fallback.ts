import { z } from "zod";
import { aiConnectionBindingSchema, type AiConnectionBinding } from "./ai-connections.js";
import { envConfigSchema } from "./validators/secret.js";

export const USAGE_LIMIT_FALLBACK_ADAPTER_TYPES = ["claude_local", "codex_local"] as const;
export type UsageLimitFallbackAdapterType = (typeof USAGE_LIMIT_FALLBACK_ADAPTER_TYPES)[number];
export type UsageLimitFallbackLane = "primary" | "fallback";

// Settings the fallback inherits from the primary so the agent keeps its instructions, skills, workspace and confinement.
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

const fallbackAdapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  if (value.env === undefined) return;
  if (!envConfigSchema.safeParse(value.env).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "usageLimitFallback.adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const usageLimitFallbackConfigSchema = z.object({
  enabled: z.boolean(),
  adapterType: z.enum(USAGE_LIMIT_FALLBACK_ADAPTER_TYPES),
  adapterConfig: fallbackAdapterConfigSchema.default({}),
  aiConnection: aiConnectionBindingSchema.optional(),
  switchBack: z.literal("on_reset").default("on_reset"),
}).strict();

export type UsageLimitFallbackConfig = z.infer<typeof usageLimitFallbackConfigSchema>;

export const usageLimitFallbackStateSchema = z.object({
  activeUntil: z.string().datetime(),
  activatedAt: z.string().datetime(),
  sourceRunId: z.string().min(1),
  primaryAdapterType: z.string().min(1),
  fallbackAdapterType: z.string().min(1),
  reason: z.literal("provider_quota"),
  notifiedIssueIds: z.array(z.string()).default([]),
});

export type UsageLimitFallbackState = z.infer<typeof usageLimitFallbackStateSchema>;

export const USAGE_LIMIT_FALLBACK_STATE_KEY = "usageLimitFallback";
export const USAGE_LIMIT_FALLBACK_MAX_NOTIFIED_ISSUES = 200;

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

export function buildUsageLimitFallbackAdapterConfig(
  primaryAdapterConfig: unknown,
  fallback: Pick<UsageLimitFallbackConfig, "adapterConfig">,
): Record<string, unknown> {
  const primary = isRecord(primaryAdapterConfig) ? primaryAdapterConfig : {};
  const inherited: Record<string, unknown> = {};
  for (const key of USAGE_LIMIT_FALLBACK_INHERITED_CONFIG_KEYS) {
    if (primary[key] !== undefined) inherited[key] = primary[key];
  }
  return { ...inherited, ...fallback.adapterConfig };
}

function sameBinding(left: AiConnectionBinding | undefined, right: AiConnectionBinding | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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
  if (input.fallback.adapterType === input.primaryAdapterType && sameBinding(input.fallback.aiConnection, input.primaryAiConnection)) {
    return "The fallback must use a different adapter or a different AI account than the primary";
  }
  return null;
}
