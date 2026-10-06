import { describe, expect, it } from "vitest";
import {
  buildUsageLimitFallbackAdapterConfig,
  isUsageLimitFallbackStateActive,
  readUsageLimitFallbackConfig,
  readUsageLimitFallbackState,
  usageLimitFallbackConfigProblem,
  usageLimitFallbackConfigSchema,
  type UsageLimitFallbackConfig,
} from "./usage-limit-fallback.js";
import { agentRuntimeConfigSchema } from "./validators/agent.js";

const codexFallback: UsageLimitFallbackConfig = {
  enabled: true,
  adapterType: "codex_local",
  adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "high" },
  switchBack: "on_reset",
};

const sharedClaudeBinding = {
  provider: "anthropic",
  method: "subscription",
  mode: "shared",
  connectionId: "11111111-1111-4111-8111-111111111111",
  grantId: "22222222-2222-4222-8222-222222222222",
} as const;

describe("usageLimitFallbackConfigSchema", () => {
  it("fills in the defaults for adapterConfig and switchBack", () => {
    const parsed = usageLimitFallbackConfigSchema.parse({ enabled: true, adapterType: "codex_local" });
    expect(parsed.adapterConfig).toEqual({});
    expect(parsed.switchBack).toBe("on_reset");
  });

  it("rejects an adapter outside the allow-list, such as paperclip_runner", () => {
    expect(usageLimitFallbackConfigSchema.safeParse({ enabled: true, adapterType: "paperclip_runner" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(usageLimitFallbackConfigSchema.safeParse({ ...codexFallback, chain: [] }).success).toBe(false);
  });

  it("rejects an invalid env map in the fallback adapterConfig", () => {
    const result = usageLimitFallbackConfigSchema.safeParse({ ...codexFallback, adapterConfig: { env: "OPENAI_API_KEY=x" } });
    expect(result.success).toBe(false);
  });

  it("is validated as part of the agent runtime config", () => {
    expect(agentRuntimeConfigSchema.safeParse({ usageLimitFallback: codexFallback }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ usageLimitFallback: { enabled: true } }).success).toBe(false);
  });
});

describe("readUsageLimitFallbackConfig", () => {
  it("returns the config when it is present and enabled", () => {
    expect(readUsageLimitFallbackConfig({ usageLimitFallback: codexFallback })).toEqual(codexFallback);
  });

  it("returns null when the fallback is absent, disabled or invalid", () => {
    expect(readUsageLimitFallbackConfig({})).toBeNull();
    expect(readUsageLimitFallbackConfig(null)).toBeNull();
    expect(readUsageLimitFallbackConfig({ usageLimitFallback: { ...codexFallback, enabled: false } })).toBeNull();
    expect(readUsageLimitFallbackConfig({ usageLimitFallback: { ...codexFallback, adapterType: "process" } })).toBeNull();
  });
});

describe("buildUsageLimitFallbackAdapterConfig", () => {
  const claudeConfig = {
    cwd: "/work/repo",
    instructionsFilePath: "/agents/skynet/AGENTS.md",
    instructionsBundleMode: "managed",
    paperclipSkillSync: { desiredSkills: ["deep-code-review"] },
    env: { GITHUB_TOKEN: { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333" } },
    networkScope: "allowlist",
    networkAllowlist: ["api.anthropic.com"],
    timeoutSec: 1800,
    model: "claude-opus-5-5",
    effort: "high",
    dangerouslySkipPermissions: true,
    command: "claude",
    agentCommand: "/opt/claude-agent-acp",
    maxTurnsPerRun: 200,
  };

  it("keeps the agent's shared settings and drops Claude-only settings", () => {
    const config = buildUsageLimitFallbackAdapterConfig(claudeConfig, codexFallback);
    expect(config).toMatchObject({
      cwd: "/work/repo",
      instructionsFilePath: "/agents/skynet/AGENTS.md",
      instructionsBundleMode: "managed",
      paperclipSkillSync: { desiredSkills: ["deep-code-review"] },
      env: claudeConfig.env,
      networkScope: "allowlist",
      timeoutSec: 1800,
      model: "gpt-6-astra",
      modelReasoningEffort: "high",
    });
    for (const key of ["effort", "dangerouslySkipPermissions", "command", "agentCommand", "maxTurnsPerRun"]) {
      expect(config).not.toHaveProperty(key);
    }
  });

  it("lets the fallback override an inherited setting, such as the network allowlist", () => {
    const config = buildUsageLimitFallbackAdapterConfig(claudeConfig, {
      adapterConfig: { networkAllowlist: ["api.openai.com", "chatgpt.com"] },
    });
    expect(config.networkAllowlist).toEqual(["api.openai.com", "chatgpt.com"]);
  });

  it("returns only the fallback settings when the primary config is not an object", () => {
    expect(buildUsageLimitFallbackAdapterConfig(null, codexFallback)).toEqual(codexFallback.adapterConfig);
  });
});

describe("usage-limit fallback state", () => {
  const state = {
    activeUntil: "2026-10-06T14:00:00.000Z",
    activatedAt: "2026-10-06T09:00:00.000Z",
    sourceRunId: "run-1",
    primaryAdapterType: "claude_local",
    fallbackAdapterType: "codex_local",
    reason: "provider_quota",
  };

  it("reads the state from agent runtime stateJson and defaults notifiedIssueIds", () => {
    expect(readUsageLimitFallbackState({ usageLimitFallback: state })).toEqual({ ...state, notifiedIssueIds: [] });
    expect(readUsageLimitFallbackState({})).toBeNull();
    expect(readUsageLimitFallbackState({ usageLimitFallback: { ...state, reason: "other" } })).toBeNull();
  });

  it("is active only until activeUntil", () => {
    const parsed = readUsageLimitFallbackState({ usageLimitFallback: state });
    expect(isUsageLimitFallbackStateActive(parsed, new Date("2026-10-06T13:59:59.000Z"))).toBe(true);
    expect(isUsageLimitFallbackStateActive(parsed, new Date("2026-10-06T14:00:00.000Z"))).toBe(false);
    expect(isUsageLimitFallbackStateActive(null, new Date("2026-10-06T10:00:00.000Z"))).toBe(false);
  });
});

describe("usageLimitFallbackConfigProblem", () => {
  it("accepts a different adapter", () => {
    expect(usageLimitFallbackConfigProblem({ primaryAdapterType: "claude_local", fallback: codexFallback })).toBeNull();
  });

  it("accepts the same adapter with a different account", () => {
    const fallback = { ...codexFallback, adapterType: "claude_local" as const, aiConnection: sharedClaudeBinding };
    expect(usageLimitFallbackConfigProblem({ primaryAdapterType: "claude_local", fallback })).toBeNull();
  });

  it("rejects the same adapter with the same account", () => {
    const fallback = { ...codexFallback, adapterType: "claude_local" as const, aiConnection: sharedClaudeBinding };
    expect(usageLimitFallbackConfigProblem({
      primaryAdapterType: "claude_local",
      primaryAiConnection: sharedClaudeBinding,
      fallback,
    })).toMatch(/different adapter or a different AI account/);
  });

  it("rejects the same account even when the binding keys are in a different order", () => {
    const reordered = {
      grantId: sharedClaudeBinding.grantId,
      connectionId: sharedClaudeBinding.connectionId,
      mode: "shared",
      method: "subscription",
      provider: "anthropic",
    } as const;
    const fallback = { ...codexFallback, adapterType: "claude_local" as const, aiConnection: reordered };
    expect(usageLimitFallbackConfigProblem({
      primaryAdapterType: "claude_local",
      primaryAiConnection: sharedClaudeBinding,
      fallback,
    })).toMatch(/different adapter or a different AI account/);
  });

  it("rejects a primary adapter outside the allow-list", () => {
    expect(usageLimitFallbackConfigProblem({ primaryAdapterType: "paperclip_runner", fallback: codexFallback })).toMatch(/supported only/);
  });
});
