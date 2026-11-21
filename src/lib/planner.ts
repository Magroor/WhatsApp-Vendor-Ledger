import { civilDayDiff, civilKey, civilOf, parseCivil, resolveTimeZone } from "./time";
import { computeOpenLots, loadLedgerRows, loadOpeningBalances, type OpenLot } from "./reports";
import { getSettings } from "./settings";

/** Days (inclusive of today) that count as "this week" for the planner. */
export const PLAN_WINDOW_DAYS = 7;

export type PayPlanVendor = {
  vendorId: number;
  vendorName: string;
  currency: string;
  /** Sum of open lots whose due date is before today. */
  overdueMinor: number;
  /** Sum of open lots due today .. today+7. */
  dueSoonMinor: number;
  /** Sum of open lots due later than the window. */
  laterMinor: number;
  /** overdueMinor + dueSoonMinor: what to pay this week. */
  dueNowMinor: number;
  /** Earliest due date (YYYY-MM-DD) among this-week + overdue lots. */
  earliestDue: string | null;
  /** Days the oldest overdue lot is late (0 when nothing is overdue). */
  daysOverdue: number;
  /** Days until the earliest not-yet-overdue lot is due (null if none this week). */
  dueInDays: number | null;
  /** Human label: "overdue 12 days" / "due in 3 days" / "due today". */
  label: string;
};

export type PayPlan = {
  currency: string;
  neededThisWeekMinor: number;
  overdueMinor: number;
  laterMinor: number;
  /** Only vendors with something overdue or due this week, overdue first. */
  vendors: PayPlanVendor[];
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Group open lots (already FIFO-settled, see computeOpenLots) per vendor into
 * overdue / due within the next 7 days / later. Lots without a due date
 * (opening balances, legacy rows) count as due today. Pure.
 */
export function buildPayPlan(lots: OpenLot[], now: Date, tz?: string): PayPlan {
  const zone = resolveTimeZone(tz);
  const today = civilOf(now, zone);
  const byVendor = new Map<number, PayPlanVendor & { _earliestDiff: number | null; _nextDiff: number | null }>();

  for (const lot of lots) {
    if (lot.remainingMinor <= 0) continue;
    const due = lot.isOpening ? null : parseCivil(lot.dueDate);
    const diff = due ? civilDayDiff(today, due) : 0; // negative = overdue
    let v = byVendor.get(lot.vendorId);
    if (!v) {
      v = {
        vendorId: lot.vendorId,
        vendorName: lot.vendorName,
        currency: lot.currency,
        overdueMinor: 0,
        dueSoonMinor: 0,
        laterMinor: 0,
        dueNowMinor: 0,
        earliestDue: null,
        daysOverdue: 0,
        dueInDays: null,
        label: "",
        _earliestDiff: null,
        _nextDiff: null,
      };
      byVendor.set(lot.vendorId, v);
    }
    if (diff < 0) {
      v.overdueMinor += lot.remainingMinor;
      v.daysOverdue = Math.max(v.daysOverdue, -diff);
    } else if (diff <= PLAN_WINDOW_DAYS) {
      v.dueSoonMinor += lot.remainingMinor;
      v._nextDiff = v._nextDiff === null ? diff : Math.min(v._nextDiff, diff);
    } else {
      v.laterMinor += lot.remainingMinor;
      continue;
    }
    v._earliestDiff = v._earliestDiff === null ? diff : Math.min(v._earliestDiff, diff);
  }

  const vendors: PayPlanVendor[] = [];
  let overdueMinor = 0;
  let laterMinor = 0;
  let neededThisWeekMinor = 0;
  for (const v of byVendor.values()) {
    laterMinor += v.laterMinor;
    v.dueNowMinor = v.overdueMinor + v.dueSoonMinor;
    if (v.dueNowMinor <= 0) continue;
    overdueMinor += v.overdueMinor;
    neededThisWeekMinor += v.dueNowMinor;
    v.dueInDays = v._nextDiff;
    if (v._earliestDiff !== null) {
      const d = new Date(Date.UTC(today.y, today.m - 1, today.d + v._earliestDiff));
      v.earliestDue = civilKey({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
    }
    v.label =
      v.daysOverdue > 0
        ? `overdue ${plural(v.daysOverdue, "day")}`
        : v.dueInDays === 0
          ? "due today"
          : `due in ${plural(v.dueInDays ?? 0, "day")}`;
    const { _earliestDiff, _nextDiff, ...pub } = v;
    void _earliestDiff;
    void _nextDiff;
    vendors.push(pub);
  }

  // Overdue first (most days late first), then by earliest due date, then bigger amount.
  vendors.sort((a, b) => {
    const ao = a.daysOverdue > 0 ? 0 : 1;
    const bo = b.daysOverdue > 0 ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (a.earliestDue !== b.earliestDue) return (a.earliestDue ?? "") < (b.earliestDue ?? "") ? -1 : 1;
    return b.dueNowMinor - a.dueNowMinor;
  });

  return {
    currency: vendors[0]?.currency ?? lots[0]?.currency ?? "PKR",
    neededThisWeekMinor,
    overdueMinor,
    laterMinor,
    vendors,
  };
}

/** Loads confirmed rows + opening balances (like getVendorsList) and builds the plan. */
export async function getPayPlan(): Promise<PayPlan> {
  const [settings, rows, openings] = await Promise.all([
    getSettings(),
    loadLedgerRows({ statuses: ["confirmed"] }),
    loadOpeningBalances(),
  ]);
  const tz = resolveTimeZone((settings as { timeZone?: unknown }).timeZone);
  const now = new Date();
  const lots = computeOpenLots(rows, now, { openings, timeZone: tz });
  return buildPayPlan(lots, now, tz);
}
