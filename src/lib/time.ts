/**
 * Business-timezone aware date helpers.
 *
 * All period maths is done on *civil* (calendar) dates in the business
 * timezone and then converted to UTC instants, so a server running in UTC
 * still produces the correct week / month / year edges and day buckets, and
 * DST transitions never shift a boundary by an hour.
 *
 * Timezone source (first valid wins): explicit argument, app setting
 * `timeZone`, env BUSINESS_TIMEZONE / NEXT_PUBLIC_BUSINESS_TIMEZONE,
 * default Asia/Karachi.
 */

export const DEFAULT_BUSINESS_TZ = "Asia/Karachi";
const DAY_MS = 86400000;

export type CivilDate = { y: number; m: number; d: number }; // m = 1..12

const validCache = new Map<string, boolean>();

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  const cached = validCache.get(tz);
  if (cached !== undefined) return cached;
  let valid = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    valid = true;
  } catch {
    valid = false;
  }
  validCache.set(tz, valid);
  return valid;
}

/** Resolve the business timezone, falling back to env and then Asia/Karachi. */
export function resolveTimeZone(candidate?: unknown): string {
  if (isValidTimeZone(candidate)) return candidate;
  const env =
    typeof process !== "undefined"
      ? process.env?.BUSINESS_TIMEZONE ?? process.env?.NEXT_PUBLIC_BUSINESS_TIMEZONE
      : undefined;
  if (isValidTimeZone(env)) return env;
  return DEFAULT_BUSINESS_TZ;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type ZonedParts = CivilDate & { hour: number; minute: number; second: number };

export function zonedParts(date: Date | number, tz?: string): ZonedParts {
  const zone = resolveTimeZone(tz);
  const parts = partsFormatter(zone).formatToParts(typeof date === "number" ? date : date.getTime());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Civil date of an instant in the business timezone. */
export function civilOf(date: Date | number, tz?: string): CivilDate {
  const p = zonedParts(date, tz);
  return { y: p.y, m: p.m, d: p.d };
}

/** Offset (ms) of tz at the given instant: localWallClock - utc. */
function offsetMs(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock time in tz -> UTC instant (two-pass, DST safe). */
export function zonedToUtc(
  civil: CivilDate,
  tz?: string,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const zone = resolveTimeZone(tz);
  const guess = Date.UTC(civil.y, civil.m - 1, civil.d, hour, minute, second, ms);
  const off1 = offsetMs(guess, zone);
  let t = guess - off1;
  const off2 = offsetMs(t, zone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** Normalise via UTC arithmetic (handles month/day overflow). */
export function normalizeCivil(y: number, m: number, d: number): CivilDate {
  const x = new Date(Date.UTC(y, m - 1, d));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

export function addDays(c: CivilDate, days: number): CivilDate {
  return normalizeCivil(c.y, c.m, c.d + days);
}

/** Whole calendar days from a to b (b - a). */
export function civilDayDiff(a: CivilDate, b: CivilDate): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** 0 = Monday ... 6 = Sunday */
export function civilWeekday(c: CivilDate): number {
  return (new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function civilKey(c: CivilDate): string {
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

/** Parse "YYYY-MM-DD" (a calendar date, never timezone-shifted). */
export function parseCivil(s: string | null | undefined): CivilDate | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** ISO-8601 week: week-year is the year of the week's Thursday. */
export function isoWeek(c: CivilDate): { year: number; week: number } {
  const thursday = addDays(c, 3 - civilWeekday(c));
  const jan1 = { y: thursday.y, m: 1, d: 1 };
  return { year: thursday.y, week: Math.floor(civilDayDiff(jan1, thursday) / 7) + 1 };
}

export function isoWeekKey(c: CivilDate): string {
  const { year, week } = isoWeek(c);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Date-key (YYYY-MM-DD) of an instant in the business timezone. */
export function dayKey(date: Date | number, tz?: string): string {
  return civilKey(civilOf(date, tz));
}

export function timeAgo(input: Date | string | number): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthShort(m: number): string {
  return MONTHS[(m - 1 + 12) % 12];
}

function fmtCivil(c: CivilDate): string {
  return `${c.d} ${monthShort(c.m)} ${c.y}`;
}

/** "18 Feb 2026" in the business timezone. Date-only strings are not shifted. */
export function fmtDate(input: Date | string | number | null | undefined, tz?: string): string {
  if (input === null || input === undefined || input === "") return "—";
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const c = parseCivil(input);
    if (c) return fmtCivil(c);
  }
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  return fmtCivil(civilOf(date, tz));
}

export function fmtDateTime(input: Date | string | number | null | undefined, tz?: string): string {
  if (input === null || input === undefined || input === "") return "—";
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "—";
  const p = zonedParts(date, tz);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${fmtCivil(p)} · ${hh}:${mm}`;
}
