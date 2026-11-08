const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 24 * 60 * 60_000;

/**
 * Reads a provider's "try again at 4:30 PM (America/Chicago)" or
 * "resets 2am (UTC)" wording as the next matching wall-clock instant after
 * `now`. A clock without a time zone is read as UTC.
 */
export function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(
    /(?:try again at|resets?(?:\s+at)?)\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
  );
  if (!match) return null;

  const [, monthName, dayText, yearText] = match;
  const hourValue = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  const meridiem = (match[6] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (
    meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23
  )
    return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[7] ?? match[8])?.trim();
  const monthIndex = MONTHS.indexOf(monthName?.toLowerCase() ?? "");
  const day = Number(dayText);
  // A named day, "resets Nov 12 at 6:49am (UTC)", is in the year given, else this year, or the next once over a day past.
  const namedDay = (resetInYear: (year: number) => Date, currentYear: number) => {
    if (yearText) return resetInYear(Number(yearText));
    const thisYear = resetInYear(currentYear);
    return thisYear.getTime() < now.getTime() - DAY_MS ? resetInYear(currentYear + 1) : thisYear;
  };
  if (!timeZone) {
    if (monthName) return namedDay((year) => new Date(Date.UTC(year, monthIndex, day, hour, minute)), now.getUTCFullYear());
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime())
      retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    const wallClock = (date: Date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value]),
      );
    const nowParts = wallClock(now);
    const buildRetryAt = (
      dayOffset: number,
      year = Number(nowParts.year),
      targetMonthIndex = Number(nowParts.month) - 1,
      targetDayOfMonth = Number(nowParts.day),
    ) => {
      const targetDay = new Date(
        Date.UTC(year, targetMonthIndex, targetDayOfMonth + dayOffset, hour, minute),
      );
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    if (monthName) return namedDay((year) => buildRetryAt(0, year, monthIndex, day), Number(nowParts.year));
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}
