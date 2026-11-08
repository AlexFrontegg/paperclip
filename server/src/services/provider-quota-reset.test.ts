import { describe, expect, it } from "vitest";
import { parseProviderQuotaClockReset } from "./provider-quota-reset.js";

const limitFailure = (title: string) => `ACP agent reported a terminal limit failure.\n${title}`;
const failedAt = new Date("2026-11-08T06:49:00Z");

describe("parseProviderQuotaClockReset", () => {
  it.each([
    ["Claude's session limit", limitFailure("You've hit your session limit · resets 9:50am (UTC)"), "2026-11-08T09:50:00.000Z"],
    ["Claude's session limit later the same day", limitFailure("You've hit your session limit · resets 5:10pm (UTC)"), "2026-11-08T17:10:00.000Z"],
    ["Claude's weekly limit", limitFailure("You've hit your weekly limit · resets Nov 12 at 6:49am (UTC)"), "2026-11-12T06:49:00.000Z"],
    ["Claude's session limit two days away in a zone", limitFailure("You've hit your session limit · resets Nov 10 at 1:48am (America/New_York)"), "2026-11-10T06:48:00.000Z"],
    ["Codex's usage limit on a named day", "You've hit your usage limit. Upgrade to Pro, or try again at Nov 9th, 2026 4:30 PM.", "2026-11-09T16:30:00.000Z"],
  ])("reads %s", (_label, message, resetAt) => {
    expect(parseProviderQuotaClockReset(message, failedAt)?.toISOString()).toBe(resetAt);
  });

  it("reads a named day without a year in the next year once this year's has passed", () => {
    const yearEnd = new Date("2026-12-30T10:00:00Z");
    expect(parseProviderQuotaClockReset(limitFailure("You've hit your weekly limit · resets Jan 2 at 6:49am (UTC)"), yearEnd)?.toISOString())
      .toBe("2027-01-02T06:49:00.000Z");
  });

  it("keeps a named day that just passed in its own year", () => {
    const justAfter = new Date("2026-11-12T07:00:00Z");
    expect(parseProviderQuotaClockReset(limitFailure("You've hit your weekly limit · resets Nov 12 at 6:49am (UTC)"), justAfter)?.toISOString())
      .toBe("2026-11-12T06:49:00.000Z");
  });

  it("keeps a named day read late in its own year instead of a year ahead", () => {
    const dayLater = new Date("2026-11-13T10:00:00Z");
    expect(parseProviderQuotaClockReset(limitFailure("You've hit your weekly limit · resets Nov 12 at 6:49am (UTC)"), dayLater)?.toISOString())
      .toBe("2026-11-12T06:49:00.000Z");
  });

  it("does not read a turn or budget limit as a reset", () => {
    expect(parseProviderQuotaClockReset(limitFailure("Reached maximum number of turns (5)"), failedAt)).toBeNull();
    expect(parseProviderQuotaClockReset(limitFailure("Reached maximum budget ($1)"), failedAt)).toBeNull();
  });

  it("does not read a dated reset without a clock time as an hour of its year", () => {
    expect(parseProviderQuotaClockReset(limitFailure("You've hit your weekly limit · resets Nov 9, 2026"), failedAt)).toBeNull();
    expect(parseProviderQuotaClockReset("You've hit your usage limit. Try again at Nov 9th, 2026.", failedAt)).toBeNull();
  });
});
