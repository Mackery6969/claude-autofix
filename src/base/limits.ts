export type LimitType = "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "seven_day_overage_included" | "overage" | "unknown";

export interface UsageLimit {
  resetsAt: Date;
  type: LimitType;
}

const LIMIT_TEXT = /usage limit|limit reached|hit your [a-z ]*limit|out of (extra )?usage/i;
const EPOCH_SUFFIX = /\|(\d{10})\b/;
const RESETS_AT = /resets\s+(?:(?<month>[A-Z][a-z]{2})\s+(?<day>\d{1,2}),?\s+(?:at\s+)?)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)(?:\s*\((?<zone>[^)]+)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FALLBACK_WAIT_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function mentionsUsageLimit(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

export function limitFromText(text: string, now: Date): UsageLimit {
  return { resetsAt: resetTimeFromText(text, now) ?? new Date(now.getTime() + FALLBACK_WAIT_MS), type: limitTypeFromText(text) };
}

export function resetTimeFromText(text: string, now: Date): Date | undefined {
  const epoch = EPOCH_SUFFIX.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const match = RESETS_AT.exec(text)?.groups;
  if (!match) return undefined;
  const zone = validTimeZone(match.zone) ?? "UTC";
  const hour = (Number(match.hour) % 12) + (match.meridiem?.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(match.minute ?? 0);
  const today = datePartsIn(now, zone);
  const month = match.month ? MONTHS.indexOf(match.month.toLowerCase()) : today.month;
  const day = match.day ? Number(match.day) : today.day;
  if (month < 0) return undefined;

  const candidate = zonedTime({ year: today.year, month, day, hour, minute }, zone);
  if (candidate.getTime() > now.getTime()) return candidate;
  if (match.month) return zonedTime({ year: today.year + 1, month, day, hour, minute }, zone);
  return new Date(candidate.getTime() + DAY_MS);
}

function limitTypeFromText(text: string): LimitType {
  if (/weekly|week|seven/i.test(text)) return "seven_day";
  if (/session|5-hour|five/i.test(text)) return "five_hour";
  return "unknown";
}

function validTimeZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function datePartsIn(date: Date, zone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month") - 1, day: value("day"), hour: value("hour"), minute: value("minute") };
}

function zonedTime(parts: DateParts, zone: string): Date {
  const asUtc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute);
  const offset = offsetMinutes(new Date(asUtc), zone);
  const guess = new Date(asUtc - offset * 60_000);
  const correctedOffset = offsetMinutes(guess, zone);
  return correctedOffset === offset ? guess : new Date(asUtc - correctedOffset * 60_000);
}

function offsetMinutes(date: Date, zone: string): number {
  const parts = datePartsIn(date, zone);
  const local = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute);
  return Math.round((local - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

export function describeLimit(type: LimitType): string {
  switch (type) {
    case "five_hour":
      return "5-hour usage limit";
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
    case "seven_day_overage_included":
      return "weekly usage limit";
    case "overage":
      return "extra usage limit";
    default:
      return "usage limit";
  }
}
