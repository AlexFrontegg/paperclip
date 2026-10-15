// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { UsageLimitFallbackConfig } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageLimitFallbackField, UsageLimitFallbackStatus } from "./UsageLimitFallbackField";

const connectionFieldProps = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
const pickerProps = vi.hoisted(() => ({
  model: undefined as Record<string, any> | undefined,
  effort: undefined as Record<string, any> | undefined,
}));
vi.mock("../api/agents", () => ({ agentsApi: { adapterModels: vi.fn().mockResolvedValue([]) } }));
vi.mock("./ai-connections/AiConnectionField", () => ({
  AiConnectionField: (props: Record<string, unknown>) => {
    connectionFieldProps.last = props;
    return <div>Fallback account for {String(props.adapterType)}</div>;
  },
}));
vi.mock("./AgentConfigForm", () => ({
  ModelDropdown: (props: Record<string, unknown>) => {
    pickerProps.model = props;
    return <div>Fallback model picker</div>;
  },
  ThinkingEffortDropdown: (props: Record<string, unknown>) => {
    pickerProps.effort = props;
    return <div>Fallback effort picker</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const onChange = vi.fn();

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

async function mountField(props: Partial<ComponentProps<typeof UsageLimitFallbackField>> = {}) {
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UsageLimitFallbackField companyId="company" agentId="agent" agentName="SKynet" primaryAdapterType="claude_local"
          value={undefined} onChange={onChange} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  ));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionFieldProps.last = undefined;
  pickerProps.model = undefined;
  pickerProps.effort = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  client.clear();
});

describe("UsageLimitFallbackField", () => {
  it("renders nothing for a primary adapter that cannot use a fallback", async () => {
    await mountField({ primaryAdapterType: "gemini_local" });
    expect(container.querySelector("[data-testid='usage-limit-fallback']")).toBeNull();
  });

  it("turns the fallback on with the other supported adapter as the default", async () => {
    await mountField();
    expect(container.textContent).not.toContain("Fallback account");
    const toggle = container.querySelector<HTMLElement>("[data-testid='usage-limit-fallback-toggle']");
    expect(toggle).not.toBeNull();
    flushSync(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith({ enabled: true, adapterType: "codex_local", adapterConfig: {}, switchBack: "on_reset", switchWhenUnavailable: true });
  });

  it("shows the fallback account and model pickers for the chosen fallback adapter", async () => {
    const value: UsageLimitFallbackConfig = { enabled: true, adapterType: "codex_local", adapterConfig: { model: "gpt-x" }, switchBack: "on_reset", switchWhenUnavailable: false };
    await mountField({ value });
    expect(container.textContent).toContain("Fallback account for codex_local");
    expect(container.textContent).toContain("Fallback model picker");
    expect(connectionFieldProps.last).toMatchObject({ adapterType: "codex_local", model: "gpt-x" });
    expect(connectionFieldProps.last).not.toHaveProperty("legacy");
  });
});

describe("UsageLimitFallbackField model and effort", () => {
  const codexFallback: UsageLimitFallbackConfig = { enabled: true, adapterType: "codex_local", adapterConfig: { model: "gpt-x" }, switchBack: "on_reset", switchWhenUnavailable: false };
  const claudeFallback: UsageLimitFallbackConfig = { ...codexFallback, adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" } };

  it("labels the fallback pickers once and stores a Codex effort under modelReasoningEffort", async () => {
    await mountField({ value: codexFallback });
    expect(pickerProps.model).toMatchObject({ label: "Fallback model", defaultLabel: undefined });
    expect(pickerProps.effort).toMatchObject({ label: "Fallback thinking effort", value: "" });
    expect(pickerProps.effort!.options[0]).toEqual({ id: "", label: "Auto" });
    flushSync(() => pickerProps.effort!.onChange("high"));
    expect(onChange).toHaveBeenCalledWith({ ...codexFallback, adapterConfig: { model: "gpt-x", modelReasoningEffort: "high" } });
  });

  it("stores a Claude effort under effort and offers the model's efforts", async () => {
    await mountField({ primaryAdapterType: "codex_local", value: { ...claudeFallback, adapterConfig: { ...claudeFallback.adapterConfig, effort: "max" } } });
    expect(pickerProps.effort!.value).toBe("max");
    expect(pickerProps.effort!.options.map((option: { id: string }) => option.id)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    flushSync(() => pickerProps.effort!.onChange(""));
    expect(onChange).toHaveBeenCalledWith({ ...claudeFallback, adapterConfig: { model: "claude-opus-5-5", effort: undefined } });
  });

  it("drops an effort the newly chosen fallback model does not support", async () => {
    await mountField({ primaryAdapterType: "codex_local", value: { ...claudeFallback, adapterConfig: { ...claudeFallback.adapterConfig, effort: "max" } } });
    flushSync(() => pickerProps.model!.onChange("claude-sonnet-4-5"));
    expect(onChange).toHaveBeenCalledWith({ ...claudeFallback, adapterConfig: { model: "claude-sonnet-4-5", effort: undefined } });
  });

  it("offers the primary model's efforts when a same-adapter fallback keeps the primary's model", async () => {
    await mountField({ primaryAdapterConfig: { model: "claude-sonnet-4-5" }, value: { ...claudeFallback, adapterConfig: {} } });
    expect(pickerProps.effort!.options.map((option: { id: string }) => option.id)).toEqual(["", "low", "medium", "high"]);
  });

  it("keeps an unsupported stored effort visible instead of showing it as the default", async () => {
    await mountField({ primaryAdapterConfig: { model: "claude-sonnet-4-5" }, value: { ...claudeFallback, adapterConfig: { effort: "max" } } });
    expect(pickerProps.effort!.value).toBe("max");
    expect(pickerProps.effort!.options.at(-1)).toEqual({ id: "max", label: "Max (not supported by this model)" });
  });

  it("drops an effort the primary's model does not support when the fallback switches back to it", async () => {
    await mountField({ primaryAdapterConfig: { model: "claude-sonnet-4-5" }, value: { ...claudeFallback, adapterConfig: { model: "claude-opus-5-5", effort: "max" } } });
    flushSync(() => pickerProps.model!.onChange(""));
    expect(onChange).toHaveBeenCalledWith({ ...claudeFallback, adapterConfig: { model: undefined, effort: undefined } });
  });

  it("says a same-adapter fallback keeps the primary's model and effort by default", async () => {
    await mountField({ value: claudeFallback });
    expect(pickerProps.model!.defaultLabel).toBe("Same as primary");
    expect(pickerProps.effort!.options[0]).toEqual({ id: "", label: "Same as primary" });
  });
});

describe("UsageLimitFallbackField safety controls", () => {
  const enabledCodex: UsageLimitFallbackConfig = { enabled: true, adapterType: "codex_local", adapterConfig: {}, switchBack: "on_reset", switchWhenUnavailable: false };

  it("warns that a same-adapter fallback on the primary's default account would move the primary too", async () => {
    const primaryDefault = { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const;
    await mountField({ value: { ...enabledCodex, adapterType: "claude_local" }, primaryAiConnection: primaryDefault });
    expect(container.querySelector("[data-testid='usage-limit-fallback-shares-default']")).not.toBeNull();
    await mountField({ value: enabledCodex, primaryAiConnection: primaryDefault });
    expect(container.querySelector("[data-testid='usage-limit-fallback-shares-default']")).toBeNull();
  });

  it("still lets the user turn the fallback off after switching the primary to an unsupported adapter", async () => {
    await mountField({ primaryAdapterType: "gemini_local", value: enabledCodex });
    expect(container.textContent).toContain("works only with Claude Code and Codex agents");
    flushSync(() => container.querySelector<HTMLElement>("[data-testid='usage-limit-fallback-toggle']")!.click());
    expect(onChange).toHaveBeenCalledWith({ ...enabledCodex, enabled: false });
  });

  it("shows the Codex bypass setting explicitly and lets the user turn it off", async () => {
    await mountField({ value: enabledCodex });
    const toggle = container.querySelector<HTMLElement>("[data-testid='usage-limit-fallback-codex-bypass']");
    expect(toggle).not.toBeNull();
    flushSync(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith({ ...enabledCodex, adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false } });
  });

  it("lets the user also switch when the primary is down or signed out", async () => {
    await mountField({ value: enabledCodex });
    expect(container.textContent).toContain("Also switch when Claude Code is down or signed out");
    flushSync(() => container.querySelector<HTMLElement>("[data-testid='usage-limit-fallback-when-unavailable']")!.click());
    expect(onChange).toHaveBeenCalledWith({ ...enabledCodex, switchWhenUnavailable: true });
  });

  it("keeps a sandboxed Codex primary's permission checks on a Claude fallback", async () => {
    await mountField({
      primaryAdapterType: "codex_local",
      primaryAdapterConfig: { dangerouslyBypassApprovalsAndSandbox: false },
      value: { enabled: true, adapterType: "claude_local", adapterConfig: {}, switchBack: "on_reset", switchWhenUnavailable: false },
    });
    const toggle = container.querySelector<HTMLElement>("[data-testid='usage-limit-fallback-claude-skip-permissions']");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    flushSync(() => toggle!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ adapterConfig: { dangerouslySkipPermissions: true } }));
  });

  it("hides the Codex bypass setting when the fallback keeps the Codex primary's settings", async () => {
    await mountField({ primaryAdapterType: "codex_local", value: enabledCodex });
    expect(container.querySelector("[data-testid='usage-limit-fallback-codex-bypass']")).toBeNull();
  });
});

describe("UsageLimitFallbackStatus", () => {
  const stateJson = (activeUntil: string) => ({ usageLimitFallback: {
    activeUntil,
    activatedAt: "2026-10-06T09:00:00.000Z",
    sourceRunId: "run-1",
    primaryAdapterType: "claude_local",
    fallbackAdapterType: "codex_local",
    reason: "provider_quota",
  } });

  it("shows the fallback and lets the user return to the primary while it is active", async () => {
    const onReturnToPrimary = vi.fn();
    flushSync(() => root.render(<UsageLimitFallbackStatus stateJson={stateJson("2999-01-01T00:00:00.000Z")} pending={false} onReturnToPrimary={onReturnToPrimary} />));
    expect(container.textContent).toContain("running on Codex");
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.startsWith("Return to"));
    expect(button).toBeDefined();
    flushSync(() => button!.click());
    expect(onReturnToPrimary).toHaveBeenCalledTimes(1);
  });

  it("says the fallback is paused and the agent is waiting for the primary", async () => {
    const suspended = { usageLimitFallback: { ...stateJson("2999-01-01T00:00:00.000Z").usageLimitFallback, suspendedReason: "codex_auth_required" } };
    flushSync(() => root.render(<UsageLimitFallbackStatus stateJson={suspended} pending={false} onReturnToPrimary={vi.fn()} />));
    expect(container.textContent).toContain("the Codex fallback cannot run (codex_auth_required), waiting for Claude Code");
    expect(container.textContent).not.toContain("running on Codex");
  });

  it("says why the agent switched when the primary is down or signed out", async () => {
    const base = stateJson("2999-01-01T00:00:00.000Z").usageLimitFallback;
    flushSync(() => root.render(<UsageLimitFallbackStatus stateJson={{ usageLimitFallback: { ...base, reason: "provider_outage" } }} pending={false} onReturnToPrimary={vi.fn()} />));
    expect(container.textContent).toContain("Claude Code is not responding: running on Codex until");
    flushSync(() => root.render(<UsageLimitFallbackStatus stateJson={{ usageLimitFallback: { ...base, reason: "primary_signed_out", waitForReconnect: true } }} pending={false} onReturnToPrimary={vi.fn()} />));
    expect(container.textContent).toContain("Claude Code needs to sign in again: running on Codex until Claude Code is reconnected");
  });

  it("stays visible while waiting for the primary's account to be reconnected", async () => {
    const waiting = { usageLimitFallback: { ...stateJson("2000-01-01T00:00:00.000Z").usageLimitFallback, reason: "primary_signed_out", waitForReconnect: true } };
    flushSync(() => root.render(<UsageLimitFallbackStatus stateJson={waiting} pending={false} onReturnToPrimary={vi.fn()} />));
    expect(container.textContent).toContain("running on Codex until Claude Code is reconnected");
  });

  it("renders nothing once the fallback has expired", async () => {
    flushSync(() => root.render(<UsageLimitFallbackStatus stateJson={stateJson("2000-01-01T00:00:00.000Z")} pending={false} onReturnToPrimary={vi.fn()} />));
    expect(container.querySelector("[data-testid='usage-limit-fallback-status']")).toBeNull();
  });
});
