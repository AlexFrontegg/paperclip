// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AgentAiHealth, CompanyAiConnectionHealth, CompanyAiHealth } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AI_HEALTH_DISMISS_MS } from "../lib/ai-health";
import { AgentAiHealthBadge, AiAccountHealthBar, AiAccountHealthPill } from "./AiAccountHealth";

const healthApi = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock("../api/ai-connections", () => ({ aiConnectionsApi: healthApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const agentOnBackup: AgentAiHealth = {
  agentId: "forge", lane: "fallback", fallbackActive: true, noWorkingAi: false,
  since: "2026-10-19T07:54:00.000Z", until: "2026-10-19T08:24:00.000Z", waitForReconnect: true,
  reason: "primary_signed_out", suspendedReason: null, backupIssue: null,
  primaryAdapterType: "claude_local", primaryModel: "claude-opus", primaryConnectionKey: "account-1",
  fallbackAdapterType: "codex_local", fallbackModel: "gpt-6-astra", fallbackConnectionKey: "account-2",
};
const agentWithoutAi: AgentAiHealth = {
  ...agentOnBackup, agentId: "nureview", lane: "primary", fallbackActive: false, noWorkingAi: true,
  since: null, until: null, waitForReconnect: false, reason: null, backupIssue: "account", fallbackConnectionKey: "account-3",
};
const claudeForAll: CompanyAiConnectionHealth = { key: "account-1", id: "claude-for-all", name: "Claude for all", provider: "anthropic", status: "needs_attention" };
const brokenClaude: CompanyAiHealth = { connections: [claudeForAll], agents: [agentOnBackup] };

let root: Root;
let container: HTMLDivElement;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

async function mount(health: CompanyAiHealth, ui: ReactNode = <><AiAccountHealthBar /><AiAccountHealthPill /></>) {
  healthApi.health.mockResolvedValue(health);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  ));
  await settle();
}

const bar = () => container.querySelector("[data-testid='ai-account-health-bar']");
const pill = () => container.querySelector<HTMLButtonElement>("[data-testid='ai-account-health-pill']");
const hideButton = () => container.querySelector<HTMLButtonElement>("button[aria-label='Hide AI account warning']");

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AiAccountHealthBar", () => {
  it("names the broken account, counts agents on their backup and links to sign in", async () => {
    await mount(brokenClaude);
    expect(bar()?.textContent).toContain("\"Claude for all\" needs sign-in. 1 agent is running on their backup.");
    const links = Array.from(bar()!.querySelectorAll("a")).map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([["Sign in", "/apps/claude-for-all/permissions"], ["Details", "/agents/all"]]);
    expect(pill()).toBeNull();
  });

  it("stays hidden for nothing to report", async () => {
    await mount({ connections: [{ ...claudeForAll, status: "connected" }], agents: [] });
    expect(bar()).toBeNull();
    expect(pill()).toBeNull();
  });

  it("reports agents with no working AI even without a broken account", async () => {
    await mount({ connections: [], agents: [{ ...agentWithoutAi, primaryConnectionKey: null, fallbackConnectionKey: null, backupIssue: "usage_limit" }] });
    expect(bar()?.textContent).toContain("1 agent has no working AI.");
    expect(bar()?.querySelector("a")?.getAttribute("href")).toBe("/apps");
  });

  it("hides behind a pill that persists across reloads and reopens the bar", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    expect(bar()).toBeNull();
    expect(pill()?.textContent).toBe("1 AI account needs attention");

    flushSync(() => root.unmount());
    root = createRoot(container);
    await mount(brokenClaude);
    expect(bar()).toBeNull();
    expect(pill()).not.toBeNull();

    flushSync(() => pill()!.click());
    expect(bar()).not.toBeNull();
    expect(pill()).toBeNull();
  });

  it("comes back when a new problem appears", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    flushSync(() => root.unmount());
    root = createRoot(container);
    await mount({ connections: [claudeForAll], agents: [agentOnBackup, agentWithoutAi] });
    expect(bar()?.textContent).toContain("1 agent is running on their backup. 1 agent has no working AI.");
    expect(pill()).toBeNull();
  });

  it("comes back by itself 24 hours after it was hidden in this session", async () => {
    await mount(brokenClaude);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const hiddenAt = Date.now();
    flushSync(() => hideButton()!.click());
    await settle();
    expect(bar()).toBeNull();
    const reopenTimers = setTimeoutSpy.mock.calls.filter(([, delay]) => typeof delay === "number" && delay > AI_HEALTH_DISMISS_MS - 60_000);
    expect(reopenTimers.length).toBeGreaterThan(0);
    for (const [, delay] of reopenTimers) expect(delay).toBeLessThanOrEqual(AI_HEALTH_DISMISS_MS);
    vi.spyOn(Date, "now").mockReturnValue(hiddenAt + AI_HEALTH_DISMISS_MS + 1);
    flushSync(() => { for (const [reopen] of reopenTimers) (reopen as () => void)(); });
    expect(bar()).not.toBeNull();
    expect(pill()).toBeNull();
  });

  it("names accounts the viewer cannot use by provider, and counts agents that lost their backup", async () => {
    const lizzy: AgentAiHealth = { ...agentWithoutAi, agentId: "lizzy", noWorkingAi: false, backupIssue: "account", fallbackConnectionKey: "account-1" };
    await mount({ connections: [{ ...claudeForAll, name: null }], agents: [lizzy] });
    expect(bar()?.textContent).toContain("A Claude account needs sign-in. 1 agent has no working backup.");
  });

  it("forgets a dismissal once the problem recovers, so the same problem shows again", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    flushSync(() => root.unmount());
    root = createRoot(container);
    await mount({ connections: [{ ...claudeForAll, status: "connected" }], agents: [] });
    expect(localStorage.getItem("paperclip:ai-health-dismissal:company-1")).toBeNull();
    flushSync(() => root.unmount());
    root = createRoot(container);
    await mount(brokenClaude);
    expect(bar()).not.toBeNull();
  });

  it("says when the AI accounts could not be checked and retries", async () => {
    healthApi.health.mockRejectedValueOnce(new Error("Network down"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider><AiAccountHealthBar /></TooltipProvider>
      </QueryClientProvider>,
    ));
    await settle();
    const failure = container.querySelector("[data-testid='ai-account-health-error']");
    expect(failure?.textContent).toContain("Could not check the AI accounts agents use.");
    healthApi.health.mockResolvedValue(brokenClaude);
    flushSync(() => Array.from(failure!.querySelectorAll("button")).find((button) => button.textContent === "Retry")!.click());
    await settle();
    expect(container.querySelector("[data-testid='ai-account-health-error']")).toBeNull();
    expect(bar()).not.toBeNull();
  });

  it("comes back 24 hours after it was hidden", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    const stored = JSON.parse(localStorage.getItem("paperclip:ai-health-dismissal:company-1")!);
    localStorage.setItem("paperclip:ai-health-dismissal:company-1", JSON.stringify({ ...stored, dismissedAt: Date.now() - AI_HEALTH_DISMISS_MS - 1 }));
    flushSync(() => root.unmount());
    root = createRoot(container);
    await mount(brokenClaude);
    expect(bar()).not.toBeNull();
  });
});

describe("AgentAiHealthBadge", () => {
  const badges = () => Array.from(container.querySelectorAll("[data-testid='agent-ai-health-badge']")).map((badge) => badge.textContent);

  it("marks agents on their backup and agents with no working AI", async () => {
    await mount({ connections: [claudeForAll], agents: [agentOnBackup, agentWithoutAi] }, (
      <>
        <AgentAiHealthBadge agentId="forge" />
        <AgentAiHealthBadge agentId="nureview" />
        <AgentAiHealthBadge agentId="pr-nudge" />
      </>
    ));
    expect(badges()).toEqual(["Backup", "No AI"]);
  });

  it("marks an agent whose backup account is broken", async () => {
    const lizzy: AgentAiHealth = { ...agentWithoutAi, agentId: "lizzy", noWorkingAi: false, backupIssue: "account", fallbackConnectionKey: "account-1" };
    await mount({ connections: [claudeForAll], agents: [lizzy] }, <AgentAiHealthBadge agentId="lizzy" />);
    expect(badges()).toEqual(["Backup broken"]);
    const badge = container.querySelector<HTMLElement>("[data-testid='agent-ai-health-badge']")!;
    flushSync(() => badge.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await settle();
    expect(document.body.textContent).toContain("WhyBackup \"Claude for all\" needs sign-in");
  });

  it("explains the backup on hover", async () => {
    await mount(brokenClaude, <AgentAiHealthBadge agentId="forge" />);
    const badge = container.querySelector<HTMLElement>("[data-testid='agent-ai-health-badge']")!;
    flushSync(() => badge.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await settle();
    const tooltip = document.body.textContent ?? "";
    expect(tooltip).toContain("Running on its backup model");
    expect(tooltip).toContain("Usual modelClaude Code claude-opus");
    expect(tooltip).toContain("NowCodex gpt-6-astra");
    expect(tooltip).toContain("Why\"Claude for all\" needs sign-in");
    expect(tooltip).toContain("Returnswhen Claude Code is signed in");
  });
});
