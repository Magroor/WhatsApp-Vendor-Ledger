import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { transactions, txItems, vendors, waMessages } from "@/db/schema";
import {
  addDays,
  civilDayDiff,
  civilKey,
  civilOf,
  civilWeekday,
  daysInMonth,
  isoWeekKey,
  monthShort,
  normalizeCivil,
  parseCivil,
  resolveTimeZone,
  zonedToUtc,
  type CivilDate,
} from "./time";
import { labelsFor, normalizeKind, type PartyKind } from "./kind";
import { getSettings } from "./settings";

export type PeriodType = "weekly" | "monthly" | "yearly";

/**
 * Pure: keep only rows whose party is of `kind`. `kindOf` maps vendorId -> kind;
 * unknown ids count as vendors (the column default). No kind = keep everything.
 */
export function filterByKind<T extends { vendorId: number }>(
  rows: readonly T[],
  kindOf: ReadonlyMap<number, unknown>,
  kind?: PartyKind,
): T[] {
  if (!kind) return [...rows];
  return rows.filter((r) => normalizeKind(kindOf.get(r.vendorId)) === kind);
}

/** Only these statuses ever count toward totals, balances, aging or counts. */
export const POSTED_STATUSES = ["confirmed"] as const;

export type LedgerRow = {
  id: number;
  vendorId: number;
  vendorName: string;
  vendorPhone: string | null;
  currency: string;
  entryType: "credit" | "debit";
  amountMinor: number;
  taxMinor: number;
  occurredAt: Date;
  dueDate: string | null;
  status: string;
  source: string;
  reference: string | null;
  description: string | null;
  confidence: number;
  messageId: number | null;
};

export type OpenLot = {
  /** Transaction id; opening-balance lots use -vendorId. */
  transactionId: number;
  vendorId: number;
  vendorName: string;
  currency: string;
  occurredAt: Date;
  dueDate: string | null;
  reference: string | null;
  originalMinor: number;
  remainingMinor: number;
  ageDays: number;
  daysOverdue: number;
  isOpening?: boolean;
};

export type PeriodRange = {
  type: PeriodType;
  key: string;
  label: string;
  /** First instant of the period (business-tz midnight). */
  start: Date;
  /** Last millisecond of the period (display / backwards compat). */
  end: Date;
  /** First instant of the next period. Query with `< endExclusive`. */
  endExclusive: Date;
  previousStart: Date;
  previousEnd: Date;
  timeZone: string;
  startDay: string;
  endDay: string;
  days: number;
};

function rangeFromCivil(
  type: PeriodType,
  startC: CivilDate,
  nextC: CivilDate,
  prevC: CivilDate,
  tz: string,
): Omit<PeriodRange, "key" | "label"> {
  const start = zonedToUtc(startC, tz);
  const endExclusive = zonedToUtc(nextC, tz);
  const previousStart = zonedToUtc(prevC, tz);
  return {
    type,
    start,
    end: new Date(endExclusive.getTime() - 1),
    endExclusive,
    previousStart,
    previousEnd: new Date(start.getTime() - 1),
    timeZone: tz,
    startDay: civilKey(startC),
    endDay: civilKey(addDays(nextC, -1)),
    days: civilDayDiff(startC, nextC),
  };
}

/**
 * Period containing `anchor`, computed on calendar dates in the business
 * timezone (default Asia/Karachi) so a UTC server gets the right edges.
 */
export function periodRange(
  type: PeriodType,
  anchor: Date = new Date(),
  timeZone?: string,
): PeriodRange {
  const tz = resolveTimeZone(timeZone);
  const c = civilOf(anchor, tz);
  if (type === "weekly") {
    const startC = addDays(c, -civilWeekday(c)); // Monday
    const base = rangeFromCivil(type, startC, addDays(startC, 7), addDays(startC, -7), tz);
    const key = isoWeekKey(startC);
    return {
      ...base,
      key,
      label: `Week ${key.slice(-2)} · ${startC.d} ${monthShort(startC.m)} ${startC.y}`,
    };
  }
  if (type === "monthly") {
    const startC = { y: c.y, m: c.m, d: 1 };
    const base = rangeFromCivil(
      type,
      startC,
      normalizeCivil(c.y, c.m + 1, 1),
      normalizeCivil(c.y, c.m - 1, 1),
      tz,
    );
    const label = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(c.y, c.m - 1, 15)));
    return { ...base, key: `${c.y}-${String(c.m).padStart(2, "0")}`, label };
  }
  const base = rangeFromCivil(
    type,
    { y: c.y, m: 1, d: 1 },
    { y: c.y + 1, m: 1, d: 1 },
    { y: c.y - 1, m: 1, d: 1 },
    tz,
  );
  return { ...base, key: `${c.y}`, label: `Year ${c.y}` };
}

/** Anchors (ISO strings) for the previous / next period. */
export function periodNavigation(range: PeriodRange): { previous: string; next: string } {
  return {
    previous: range.previousStart.toISOString(),
    next: range.endExclusive.toISOString(),
  };
}

/**
 * Parse an anchor query param. "YYYY-MM-DD" / "YYYY-MM" / "YYYY" are calendar
 * dates in the business timezone; anything else goes through Date().
 */
export function parseAnchor(raw: string | null | undefined, timeZone?: string): Date | null {
  if (!raw) return null;
  const tz = resolveTimeZone(timeZone);
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(raw.trim());
  if (m) {
    const c = { y: Number(m[1]), m: Number(m[2] ?? 1), d: Number(m[3] ?? 1) };
    if (c.y < ANCHOR_MIN_YEAR || c.y > ANCHOR_MAX_YEAR) return null;
    // Real calendar dates only: 2026-02-31 must not silently become March.
    if (c.m < 1 || c.m > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.m)) return null;
    return zonedToUtc(c, tz, 12);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y < ANCHOR_MIN_YEAR || y > ANCHOR_MAX_YEAR ? null : d;
}

/** Anchors outside this range are rejected (avoids Invalid Date / 500s at the edges). */
const ANCHOR_MIN_YEAR = 1970;
const ANCHOR_MAX_YEAR = 2200;

export const REPORT_PERIODS: PeriodType[] = ["weekly", "monthly", "yearly"];

/**
 * Shared query parsing for /api/reports and /api/reports/export. A parameter
 * that is present but invalid is an error — it must never silently widen the
 * report to all vendors or jump to the current period.
 */
export function parseReportQuery(
  params: URLSearchParams,
  timeZone?: string,
):
  | { ok: true; period: PeriodType; vendorId?: number; anchor: Date; kind: PartyKind }
  | { ok: false; error: string } {
  const kindParam = params.get("kind");
  if (kindParam && kindParam !== "vendor" && kindParam !== "customer") {
    return { ok: false, error: "kind must be vendor or customer" };
  }
  const kind: PartyKind = kindParam === "customer" ? "customer" : "vendor";
  const periodParam = params.get("period");
  let period: PeriodType = "monthly";
  if (periodParam) {
    if (!(REPORT_PERIODS as string[]).includes(periodParam)) {
      return { ok: false, error: "period must be weekly, monthly or yearly" };
    }
    period = periodParam as PeriodType;
  }
  const vendorParam = params.get("vendorId");
  let vendorId: number | undefined;
  if (vendorParam) {
    const s = vendorParam.trim();
    const n = /^\d{1,10}$/.test(s) ? Number(s) : NaN;
    if (!(n > 0 && n <= 2_147_483_647)) return { ok: false, error: "invalid vendorId" };
    vendorId = n;
  }
  const anchorParam = params.get("anchor");
  const anchor = anchorParam ? parseAnchor(anchorParam, timeZone) : new Date();
  if (!anchor) return { ok: false, error: "invalid anchor (use YYYY, YYYY-MM or YYYY-MM-DD between 1970 and 2200)" };
  return { ok: true, period, vendorId, anchor, kind };
}

export async function loadLedgerRows(options: {
  vendorId?: number;
  start?: Date;
  end?: Date;
  /** Exclusive upper bound (preferred over `end`). */
  endExclusive?: Date;
  before?: Date;
  statuses?: string[];
  /** Only parties of this kind. Omitted = every party (other callers rely on that). */
  kind?: PartyKind;
}): Promise<LedgerRow[]> {
  const statuses = options.statuses ?? [...POSTED_STATUSES];
  const filters = [
    inArray(transactions.status, statuses),
    inArray(transactions.entryType, ["credit", "debit"]),
  ];
  if (options.vendorId) filters.push(eq(transactions.vendorId, options.vendorId));
  if (options.kind) filters.push(eq(vendors.kind, options.kind));
  if (options.start) filters.push(gte(transactions.occurredAt, options.start));
  if (options.end) filters.push(lte(transactions.occurredAt, options.end));
  if (options.endExclusive) filters.push(lt(transactions.occurredAt, options.endExclusive));
  if (options.before) filters.push(lt(transactions.occurredAt, options.before));

  const rows = await db
    .select({
      id: transactions.id,
      vendorId: transactions.vendorId,
      vendorName: vendors.name,
      vendorPhone: vendors.phone,
      currency: transactions.currency,
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
      taxMinor: transactions.taxMinor,
      occurredAt: transactions.occurredAt,
      dueDate: transactions.dueDate,
      status: transactions.status,
      source: transactions.source,
      reference: transactions.reference,
      description: transactions.description,
      confidence: transactions.confidence,
      messageId: transactions.messageId,
    })
    .from(transactions)
    .innerJoin(vendors, eq(vendors.id, transactions.vendorId))
    .where(and(...filters))
    .orderBy(asc(transactions.occurredAt), asc(transactions.id));

  return rows.map((r) => ({
    ...r,
    entryType: r.entryType as "credit" | "debit",
    amountMinor: Number(r.amountMinor ?? 0),
    taxMinor: Number(r.taxMinor ?? 0),
    occurredAt: r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt),
    dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
  }));
}

export type OpeningBalance = {
  vendorId: number;
  vendorName: string;
  currency: string;
  amountMinor: number;
  asOf: Date;
};

/** vendors.opening_balance_minor (payable at onboarding; negative = advance). */
export async function loadOpeningBalances(vendorId?: number, kind?: PartyKind): Promise<OpeningBalance[]> {
  const rows = await db
    .select({
      vendorId: vendors.id,
      vendorName: vendors.name,
      currency: vendors.currency,
      amountMinor: vendors.openingBalanceMinor,
      asOf: vendors.createdAt,
    })
    .from(vendors)
    .where(
      and(
        vendorId ? eq(vendors.id, vendorId) : undefined,
        kind ? eq(vendors.kind, kind) : undefined,
      ),
    );
  return rows
    .map((r) => ({
      ...r,
      amountMinor: Number(r.amountMinor ?? 0),
      asOf: r.asOf instanceof Date ? r.asOf : new Date(r.asOf),
    }))
    .filter((r) => r.amountMinor !== 0);
}

export type PeriodSummary = {
  creditMinor: number;
  debitMinor: number;
  netMinor: number;
  creditCount: number;
  debitCount: number;
  taxMinor: number;
  avgBillMinor: number;
  largestMinor: number;
  vendorCount: number;
};

function isPosted(row: { status?: string }): boolean {
  return !row.status || (POSTED_STATUSES as readonly string[]).includes(row.status);
}

export function summarize(rows: LedgerRow[]): PeriodSummary {
  let creditMinor = 0;
  let debitMinor = 0;
  let creditCount = 0;
  let debitCount = 0;
  let taxMinor = 0;
  let largestMinor = 0;
  const vendorIds = new Set<number>();
  for (const row of rows) {
    if (!isPosted(row)) continue;
    if (row.entryType === "credit") {
      creditMinor += row.amountMinor;
      creditCount += 1;
    } else if (row.entryType === "debit") {
      debitMinor += row.amountMinor;
      debitCount += 1;
    } else continue;
    taxMinor += row.taxMinor ?? 0;
    largestMinor = Math.max(largestMinor, row.amountMinor);
    vendorIds.add(row.vendorId);
  }
  const total = creditCount + debitCount;
  return {
    creditMinor,
    debitMinor,
    netMinor: creditMinor - debitMinor,
    creditCount,
    debitCount,
    taxMinor,
    avgBillMinor: total ? Math.round((creditMinor + debitMinor) / total) : 0,
    largestMinor,
    vendorCount: vendorIds.size,
  };
}

/**
 * FIFO settlement, per vendor: each credit (bill) is an open lot; debits
 * (payments) clear that vendor's oldest lots first. Payments exceeding open
 * lots are carried forward as an advance against later bills. A positive
 * opening balance is the vendor's oldest lot; a negative one is an advance.
 * Ages / overdue days are whole calendar days in the business timezone.
 */
export function computeOpenLots(
  rows: LedgerRow[],
  now: Date = new Date(),
  options: { openings?: OpeningBalance[]; timeZone?: string } = {},
): OpenLot[] {
  const tz = resolveTimeZone(options.timeZone);
  const state = new Map<number, { lots: OpenLot[]; advance: number }>();
  const get = (vendorId: number) => {
    let s = state.get(vendorId);
    if (!s) {
      s = { lots: [], advance: 0 };
      state.set(vendorId, s);
    }
    return s;
  };

  const sorted = rows
    .filter((r) => isPosted(r) && (r.entryType === "credit" || r.entryType === "debit"))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id);

  for (const o of options.openings ?? []) {
    const s = get(o.vendorId);
    if (o.amountMinor < 0) {
      s.advance += -o.amountMinor;
      continue;
    }
    const firstTx = sorted.find((r) => r.vendorId === o.vendorId);
    const at =
      firstTx && firstTx.occurredAt.getTime() < o.asOf.getTime() ? firstTx.occurredAt : o.asOf;
    s.lots.push({
      transactionId: -o.vendorId,
      vendorId: o.vendorId,
      vendorName: o.vendorName,
      currency: o.currency,
      occurredAt: at,
      dueDate: null,
      reference: "Opening balance",
      originalMinor: o.amountMinor,
      remainingMinor: o.amountMinor,
      ageDays: 0,
      daysOverdue: 0,
      isOpening: true,
    });
  }

  for (const row of sorted) {
    const s = get(row.vendorId);
    if (row.entryType === "credit") {
      const fromAdvance = Math.min(s.advance, row.amountMinor);
      s.advance -= fromAdvance;
      s.lots.push({
        transactionId: row.id,
        vendorId: row.vendorId,
        vendorName: row.vendorName,
        currency: row.currency,
        occurredAt: row.occurredAt,
        dueDate: row.dueDate,
        reference: row.reference,
        originalMinor: row.amountMinor,
        remainingMinor: row.amountMinor - fromAdvance,
        ageDays: 0,
        daysOverdue: 0,
      });
      continue;
    }
    let remainingPayment = row.amountMinor;
    for (const lot of s.lots) {
      if (remainingPayment <= 0) break;
      if (lot.remainingMinor <= 0) continue;
      const applied = Math.min(lot.remainingMinor, remainingPayment);
      lot.remainingMinor -= applied;
      remainingPayment -= applied;
    }
    s.advance += remainingPayment;
  }

  const today = civilOf(now, tz);
  const open: OpenLot[] = [];
  for (const s of state.values()) {
    for (const lot of s.lots) {
      if (lot.remainingMinor <= 0) continue;
      lot.ageDays = Math.max(0, civilDayDiff(civilOf(lot.occurredAt, tz), today));
      const due = parseCivil(lot.dueDate);
      lot.daysOverdue = due ? Math.max(0, civilDayDiff(due, today)) : 0;
      open.push(lot);
    }
  }
  return open.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export type AgingBucket = {
  label: string;
  min: number;
  max: number;
  amountMinor: number;
  count: number;
};

/** Buckets by bill age (days since bill date) of the FIFO-remaining amount. */
export function agingBuckets(lots: OpenLot[]): AgingBucket[] {
  const defs: Array<{ label: string; min: number; max: number }> = [
    { label: "0–30 days", min: 0, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "90+ days", min: 91, max: Number.MAX_SAFE_INTEGER },
  ];
  return defs.map((def) => {
    const inBucket = lots.filter((l) => l.ageDays >= def.min && l.ageDays <= def.max);
    return {
      label: def.label,
      min: def.min,
      max: def.max,
      amountMinor: inBucket.reduce((a, l) => a + l.remainingMinor, 0),
      count: inBucket.length,
    };
  });
}

export type VendorBreakdown = {
  vendorId: number;
  vendorName: string;
  vendorPhone: string | null;
  currency: string;
  creditMinor: number;
  debitMinor: number;
  netMinor: number;
  txnCount: number;
  lastActivity: Date;
};

export function groupByVendor(rows: LedgerRow[]): VendorBreakdown[] {
  const map = new Map<number, VendorBreakdown>();
  for (const row of rows) {
    if (!isPosted(row)) continue;
    let existing = map.get(row.vendorId);
    if (!existing) {
      existing = {
        vendorId: row.vendorId,
        vendorName: row.vendorName,
        vendorPhone: row.vendorPhone,
        currency: row.currency,
        creditMinor: 0,
        debitMinor: 0,
        netMinor: 0,
        txnCount: 0,
        lastActivity: row.occurredAt,
      };
      map.set(row.vendorId, existing);
    }
    if (row.entryType === "credit") {
      existing.creditMinor += row.amountMinor;
      existing.netMinor += row.amountMinor;
    } else {
      existing.debitMinor += row.amountMinor;
      existing.netMinor -= row.amountMinor;
    }
    existing.txnCount += 1;
    if (row.occurredAt > existing.lastActivity) existing.lastActivity = row.occurredAt;
  }
  return [...map.values()].sort(
    (a, b) => b.creditMinor + b.debitMinor - (a.creditMinor + a.debitMinor),
  );
}

export type SeriesPoint = {
  label: string;
  creditMinor: number;
  debitMinor: number;
};

/** Buckets rows by business-tz calendar day (weekly/monthly) or month (yearly). */
export function buildSeries(rows: LedgerRow[], type: PeriodType, range: PeriodRange): SeriesPoint[] {
  const tz = resolveTimeZone(range.timeZone);
  const startC = civilOf(range.start, tz);
  const points: SeriesPoint[] = [];
  if (type === "yearly") {
    for (let m = 1; m <= 12; m += 1) {
      points.push({ label: monthShort(m), creditMinor: 0, debitMinor: 0 });
    }
    for (const row of rows) {
      if (!isPosted(row)) continue;
      const c = civilOf(row.occurredAt, tz);
      if (c.y !== startC.y) continue;
      if (row.entryType === "credit") points[c.m - 1].creditMinor += row.amountMinor;
      else points[c.m - 1].debitMinor += row.amountMinor;
    }
    return points;
  }
  const days = type === "weekly" ? 7 : daysInMonth(startC.y, startC.m);
  for (let i = 0; i < days; i += 1) {
    const d = addDays(startC, i);
    points.push({ label: `${d.d}/${d.m}`, creditMinor: 0, debitMinor: 0 });
  }
  for (const row of rows) {
    if (!isPosted(row)) continue;
    const idx = civilDayDiff(startC, civilOf(row.occurredAt, tz));
    if (idx < 0 || idx >= points.length) continue;
    if (row.entryType === "credit") points[idx].creditMinor += row.amountMinor;
    else points[idx].debitMinor += row.amountMinor;
  }
  return points;
}

export type ReportLineItem = {
  transactionId: number;
  vendorId: number;
  vendorName: string;
  occurredAt: Date;
  entryType: string;
  reference: string | null;
  currency: string;
  name: string;
  sku: string | null;
  qty: number;
  unit: string | null;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
};

export type ReportPayload = {
  /** Party kind covered (absent on old snapshots = vendor). */
  kind?: PartyKind;
  period: {
    type: PeriodType;
    key: string;
    label: string;
    start: string;
    end: string;
    startDay?: string;
    endDay?: string;
  };
  generatedAt: string;
  currency: string;
  summary: PeriodSummary;
  previous: PeriodSummary;
  delta: { creditPct: number; debitPct: number };
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  series: SeriesPoint[];
  vendors: VendorBreakdown[];
  aging: AgingBucket[];
  openLots: OpenLot[];
  topTransactions: LedgerRow[];
  counts: { messagesParsed: number; autoPosted: number };
  timeZone?: string;
  /** Aging is computed as of this instant: min(now, period end). */
  agingAsOf?: string;
  vendor?: { id: number; name: string; phone: string | null; currency: string; openingBalanceMinor: number } | null;
  nav?: { previous: string; next: string };
  /** Every posted entry in the period, oldest first. */
  entries?: LedgerRow[];
  /** tx_items lines for posted entries in the period. */
  lineItems?: ReportLineItem[];
};

/**
 * Report for the /reports and /reports/print pages, scoped to one party kind.
 * Lenient like the pages always were: a bad anchor falls back to now.
 */
export async function loadKindReportPage(
  period: PeriodType,
  anchorRaw: string | null | undefined,
  vendorId: number | undefined,
  kind: PartyKind,
) {
  const settings = await getSettings();
  const timeZone = resolveTimeZone((settings as { timeZone?: unknown }).timeZone);
  const report = await buildReport({
    type: period,
    anchor: parseAnchor(anchorRaw, timeZone) ?? new Date(),
    vendorId: vendorId && vendorId > 0 ? vendorId : undefined,
    kind,
    currency: settings.currency,
    timeZone,
  });
  return { settings, report, timeZone };
}

/** Report picker options: parties of one kind, by name. */
export async function loadPartyOptions(kind: PartyKind) {
  return db
    .select({ id: vendors.id, name: vendors.name, archived: vendors.archived })
    .from(vendors)
    .where(eq(vendors.kind, kind))
    .orderBy(vendors.name);
}

export async function loadReportLineItems(options: {
  vendorId?: number;
  start: Date;
  endExclusive: Date;
  kind?: PartyKind;
}): Promise<ReportLineItem[]> {
  const filters = [
    inArray(transactions.status, [...POSTED_STATUSES]),
    inArray(transactions.entryType, ["credit", "debit"]),
    gte(transactions.occurredAt, options.start),
    lt(transactions.occurredAt, options.endExclusive),
  ];
  if (options.vendorId) filters.push(eq(transactions.vendorId, options.vendorId));
  if (options.kind) filters.push(eq(vendors.kind, options.kind));
  const rows = await db
    .select({
      transactionId: txItems.transactionId,
      vendorId: transactions.vendorId,
      vendorName: vendors.name,
      occurredAt: transactions.occurredAt,
      entryType: transactions.entryType,
      reference: transactions.reference,
      currency: transactions.currency,
      name: txItems.name,
      sku: txItems.sku,
      qty: txItems.qty,
      unit: txItems.unit,
      unitPriceMinor: txItems.unitPriceMinor,
      lineTotalMinor: txItems.lineTotalMinor,
    })
    .from(txItems)
    .innerJoin(transactions, eq(transactions.id, txItems.transactionId))
    .innerJoin(vendors, eq(vendors.id, transactions.vendorId))
    .where(and(...filters))
    .orderBy(asc(transactions.occurredAt), asc(transactions.id), asc(txItems.id));
  return rows.map((r) => ({
    ...r,
    occurredAt: r.occurredAt instanceof Date ? r.occurredAt : new Date(r.occurredAt),
    qty: Number(r.qty ?? 0),
    unitPriceMinor: r.unitPriceMinor === null || r.unitPriceMinor === undefined ? null : Number(r.unitPriceMinor),
    lineTotalMinor: r.lineTotalMinor === null || r.lineTotalMinor === undefined ? null : Number(r.lineTotalMinor),
  }));
}

export async function buildReport(options: {
  type: PeriodType;
  anchor?: Date;
  vendorId?: number;
  currency?: string;
  timeZone?: string;
  now?: Date;
  /**
   * Which parties the report covers. Default "vendor": customers (who owe the
   * shop) are never mixed into vendor payables. With `vendorId` the party's own
   * kind wins.
   */
  kind?: PartyKind;
}): Promise<ReportPayload> {
  const tz = resolveTimeZone(options.timeZone);
  const realNow = options.now ?? new Date();
  const range = periodRange(options.type, options.anchor ?? realNow, tz);
  const vendorId = options.vendorId && options.vendorId > 0 ? options.vendorId : undefined;

  const vendorRow = vendorId
    ? await db
        .select({
          id: vendors.id,
          name: vendors.name,
          phone: vendors.phone,
          currency: vendors.currency,
          openingBalanceMinor: vendors.openingBalanceMinor,
          kind: vendors.kind,
        })
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .limit(1)
    : [];
  const kind: PartyKind = vendorRow[0] ? normalizeKind(vendorRow[0].kind) : normalizeKind(options.kind);
  // A single-party report is already scoped by id; otherwise filter by kind.
  const kindFilter = vendorId ? undefined : kind;

  const [rows, prevRows, beforeRows, openings, lineItems, parsedRes] = await Promise.all([
    loadLedgerRows({ vendorId, kind: kindFilter, start: range.start, endExclusive: range.endExclusive }),
    loadLedgerRows({ vendorId, kind: kindFilter, start: range.previousStart, endExclusive: range.start }),
    loadLedgerRows({ vendorId, kind: kindFilter, before: range.start }),
    loadOpeningBalances(vendorId, kindFilter),
    loadReportLineItems({ vendorId, kind: kindFilter, start: range.start, endExclusive: range.endExclusive }),
    db
      .select({ parsed: sql<number>`count(*)::int` })
      .from(waMessages)
      .where(
        and(
          gte(waMessages.receivedAt, range.start),
          lt(waMessages.receivedAt, range.endExclusive),
          eq(waMessages.parseStatus, "parsed"),
          vendorId ? eq(waMessages.vendorId, vendorId) : undefined,
          kindFilter
            ? inArray(waMessages.vendorId, db.select({ id: vendors.id }).from(vendors).where(eq(vendors.kind, kindFilter)))
            : undefined,
        ),
      ),
  ]);

  // Opening = vendor opening balance(s) + all posted movement before the period.
  const openingFromVendors = openings.reduce((a, o) => a + o.amountMinor, 0);
  const openingBalanceMinor =
    openingFromVendors +
    beforeRows.reduce((acc, r) => acc + (r.entryType === "credit" ? r.amountMinor : -r.amountMinor), 0);

  const agingAsOf = new Date(Math.min(realNow.getTime(), range.end.getTime()));
  const lots = computeOpenLots(beforeRows.concat(rows), agingAsOf, { openings, timeZone: tz });
  const summary = summarize(rows);
  const previous = summarize(prevRows);
  const pct = (curr: number, prev: number) =>
    prev === 0 ? (curr === 0 ? 0 : 100) : Math.round(((curr - prev) / prev) * 100);

  const vendor = vendorRow[0]
    ? {
        id: vendorRow[0].id,
        name: vendorRow[0].name,
        phone: vendorRow[0].phone,
        currency: vendorRow[0].currency,
        openingBalanceMinor: Number(vendorRow[0].openingBalanceMinor ?? 0),
      }
    : null;
  const currency = vendor?.currency ?? options.currency ?? rows[0]?.currency ?? "PKR";

  const topTransactions = [...rows].sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 10);

  return {
    kind,
    period: {
      type: options.type,
      key: range.key,
      label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      startDay: range.startDay,
      endDay: range.endDay,
    },
    generatedAt: realNow.toISOString(),
    currency,
    summary,
    previous,
    delta: {
      creditPct: pct(summary.creditMinor, previous.creditMinor),
      debitPct: pct(summary.debitMinor, previous.debitMinor),
    },
    openingBalanceMinor,
    closingBalanceMinor: openingBalanceMinor + summary.netMinor,
    series: buildSeries(rows, options.type, range),
    vendors: groupByVendor(rows),
    aging: agingBuckets(lots),
    openLots: [...lots].sort((a, b) => b.remainingMinor - a.remainingMinor).slice(0, 25),
    topTransactions,
    counts: {
      messagesParsed: parsedRes[0]?.parsed ?? 0,
      autoPosted: rows.filter((r) => r.source === "whatsapp").length,
    },
    timeZone: tz,
    agingAsOf: agingAsOf.toISOString(),
    vendor,
    nav: periodNavigation(range),
    entries: rows,
    lineItems,
  };
}

export async function recentTransactions(limit: number, vendorId?: number) {
  const filters = [inArray(transactions.status, ["confirmed", "draft"])];
  if (vendorId) filters.push(eq(transactions.vendorId, vendorId));
  const rows = await db
    .select({
      id: transactions.id,
      vendorId: transactions.vendorId,
      vendorName: vendors.name,
      currency: transactions.currency,
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
      occurredAt: transactions.occurredAt,
      description: transactions.description,
      reference: transactions.reference,
      status: transactions.status,
      source: transactions.source,
      confidence: transactions.confidence,
    })
    .from(transactions)
    .innerJoin(vendors, eq(vendors.id, transactions.vendorId))
    .where(and(...filters))
    .orderBy(desc(transactions.occurredAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    amountMinor: Number(r.amountMinor),
  }));
}

/* ------------------------------------------------------------------ CSV */

/** Text cell: neutralise formula injection (=,+,-,@,tab,CR) then RFC4180-quote. */
export function csvText(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minor units -> exact major-unit decimal string ("-1234.05"). */
export function csvAmount(minor: number | null | undefined): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "";
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function csvNumber(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "" : String(n);
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * CSV export. All amounts are in major units of the report currency with 2
 * decimals; dates are calendar dates in the business timezone. Lines end with
 * CRLF. The caller adds the UTF-8 BOM.
 */
export function reportToCsv(report: ReportPayload, vendorName?: string): string {
  const tz = resolveTimeZone(report.timeZone);
  const day = (v: Date | string) => civilKey(civilOf(toDate(v), tz));
  const lines: string[] = [];
  const row = (...cells: string[]) => lines.push(cells.join(","));
  // Vendor output is unchanged; customer reports use receivable wording.
  const L = labelsFor(report.kind);
  const cust = L.kind === "customer";
  const name = vendorName ?? report.vendor?.name ?? `All ${L.nounPlural.toLowerCase()}`;

  row(`${L.noun} Ledger Report`, csvText(name), csvText(report.period.type), csvText(report.period.key));
  row("Period", csvText(report.period.startDay ?? day(report.period.start)), csvText(report.period.endDay ?? day(report.period.end)));
  row("Generated", csvText(report.generatedAt), "Time zone", csvText(tz));
  row("Currency", csvText(report.currency), "Amounts in major units");
  lines.push("");
  row("Section", "Metric", "Amount");
  row("Summary", cust ? "Sales on credit" : "Credit", csvAmount(report.summary.creditMinor));
  row("Summary", cust ? "Payments received" : "Debit", csvAmount(report.summary.debitMinor));
  row("Summary", "Net movement", csvAmount(report.summary.netMinor));
  row("Summary", "Opening balance", csvAmount(report.openingBalanceMinor));
  row("Summary", cust ? "Closing balance (they owe you)" : "Closing balance", csvAmount(report.closingBalanceMinor));
  row("Summary", "Tax", csvAmount(report.summary.taxMinor));
  row("Summary", "Credit entries", csvNumber(report.summary.creditCount));
  row("Summary", "Debit entries", csvNumber(report.summary.debitCount));
  lines.push("");
  row(L.noun, "Credit", "Debit", "Net", "Txn count", "Last activity");
  for (const v of report.vendors) {
    row(
      csvText(v.vendorName),
      csvAmount(v.creditMinor),
      csvAmount(v.debitMinor),
      csvAmount(v.netMinor),
      csvNumber(v.txnCount),
      day(v.lastActivity),
    );
  }
  lines.push("");
  row("Aging bucket", "Amount", "Open lots");
  for (const a of report.aging) row(csvText(a.label), csvAmount(a.amountMinor), csvNumber(a.count));
  lines.push("");

  const entries = report.entries ?? report.topTransactions;
  const sortedEntries = [...entries].sort(
    (a, b) => toDate(a.occurredAt).getTime() - toDate(b.occurredAt).getTime() || a.id - b.id,
  );
  let running = report.openingBalanceMinor;
  row(
    report.entries ? "Entries" : "Top entries",
    "Date",
    L.noun,
    "Type",
    "Reference",
    "Description",
    "Credit",
    "Debit",
    report.entries ? "Running balance" : "",
    "Due date",
    "Source",
    "Status",
    "Confidence",
  );
  for (const t of sortedEntries) {
    running += t.entryType === "credit" ? t.amountMinor : -t.amountMinor;
    row(
      csvNumber(t.id),
      day(t.occurredAt),
      csvText(t.vendorName),
      csvText(t.entryType),
      csvText(t.reference),
      csvText(t.description),
      t.entryType === "credit" ? csvAmount(t.amountMinor) : "",
      t.entryType === "debit" ? csvAmount(t.amountMinor) : "",
      report.entries ? csvAmount(running) : "",
      csvText(t.dueDate),
      csvText(t.source),
      csvText(t.status),
      csvNumber(t.confidence),
    );
  }

  if (report.lineItems && report.lineItems.length) {
    lines.push("");
    row("Order item", "Txn", "Date", L.noun, "Type", "Reference", "Item", "SKU", "Qty", "Unit", "Unit price", "Line total");
    report.lineItems.forEach((li, i) => {
      row(
        csvNumber(i + 1),
        csvNumber(li.transactionId),
        day(li.occurredAt),
        csvText(li.vendorName),
        csvText(li.entryType),
        csvText(li.reference),
        csvText(li.name),
        csvText(li.sku),
        csvNumber(li.qty),
        csvText(li.unit),
        csvAmount(li.unitPriceMinor),
        csvAmount(li.lineTotalMinor),
      );
    });
  }

  lines.push("");
  row("Open lot", L.noun, cust ? "Sale date" : "Bill date", "Due date", "Reference", "Original", "Remaining", "Age days", "Days overdue");
  for (const lot of report.openLots) {
    row(
      lot.isOpening || lot.transactionId <= 0 ? "opening" : csvNumber(lot.transactionId),
      csvText(lot.vendorName),
      day(lot.occurredAt),
      csvText(lot.dueDate),
      csvText(lot.reference),
      csvAmount(lot.originalMinor),
      csvAmount(lot.remainingMinor),
      csvNumber(lot.ageDays),
      csvNumber(lot.daysOverdue),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Safe ASCII slug for filenames. */
export function fileSlug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .toLowerCase()
      .slice(0, 40) || "vendor"
  );
}
