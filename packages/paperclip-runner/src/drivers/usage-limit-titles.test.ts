import { describe, expect, it } from "vitest";
import { acpxTerminalResult } from "./acpx/provider-failure.js";
import { codexProviderFailure } from "./codex/provider-failure.js";

// The fork's usage-limit fallback tests replay these typed failures; the session, weekly and 429 titles are Claude Code 2.1.286's.
const claudeTerminalMessage = "ACP agent reported a terminal limit failure.";
const codexUsageLimitMessage = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:31 PM.";

describe("the Runner's typing of real usage-limit titles", () => {
  it.each([
    ["You've hit your session limit · resets 9:50am (UTC)", "quota_exhausted", "requires_action"],
    ["You've hit your weekly limit · resets Nov 12 at 6:49am (UTC)", "quota_exhausted", "requires_action"],
    ["API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.", "rate_limit", "unknown"],
    ["Reached maximum number of turns (5)", "unknown", "unknown"],
    ["Reached maximum budget ($1)", "unknown", "unknown"],
    ["error_max_turns", "unknown", "unknown"],
    ["error_max_budget_usd", "unknown", "unknown"],
  ])("types Claude's \"%s\" as %s", (title, category, retryability) => {
    const terminal = acpxTerminalResult({ status: "failed", error: { message: claudeTerminalMessage, code: "RUNTIME" } }, "claude", {}, { category: "limit", title });
    expect((terminal.error as Record<string, unknown>).providerFailure).toEqual({
      schema: "paperclip.provider-failure.v1",
      provider: "anthropic",
      phase: "turn",
      category,
      message: `${claudeTerminalMessage}\n${title}`,
      retryability,
    });
  });

  it("types Codex's usage limit as an exhausted quota", () => {
    expect(codexProviderFailure({ codexErrorInfo: "usageLimitExceeded", message: codexUsageLimitMessage }, "turn")).toEqual({
      schema: "paperclip.provider-failure.v1",
      provider: "openai",
      phase: "turn",
      category: "quota_exhausted",
      message: codexUsageLimitMessage,
      providerCode: "usageLimitExceeded",
      retryability: "requires_action",
    });
  });
});
