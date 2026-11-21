import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { transactions, txItems, vendors } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PurchaseRow = {
  vendorId: number;
  vendorName: string;
  currency: string;
  name: string; // raw name as billed
  unit: string | null;
  qty: number;
  unitPriceMinor: number;
  occurredAt: Date;
};

export type PricePoint = { date: Date; unitPriceMinor: number; qty: number };

export type PriceSeries = {
  key: string; // vendorId|normName|unit
  normName: string;
  name: string; // display name (most recent raw spelling)
  unit: string | null;
  vendorId: number;
  vendorName: string;
  currency: string;
  points: PricePoint[]; // ascending by date
};

export type PriceAlert = {
  key: string;
  normName: string;
  name: string;
  unit: string | null;
  vendorId: number;
  vendorName: string;
  currency: string;
  pct: number; // rounded to 1 decimal
  oldMinor: number;
  newMinor: number;
  since: Date; // date of the price it is compared with (previous purchase) / first of window
  date: Date; // date of the latest purchase
  basis: "previous" | "average";
};

export type AlertOptions = {
  thresholdPct?: number; // default 5
  windowDays?: number; // default 90
  recentDays?: number; // latest purchase must be within this many days of now (default 90)
};

export type VendorPrice = {
  vendorId: number;
  vendorName: string;
  unitPriceMinor: number;
  date: Date;
};

export type VendorComparison = {
  normName: string;
  name: string;
  unit: string | null;
  currency: string;
  vendors: VendorPrice[]; // sorted cheapest first
  cheapest: VendorPrice;
  priciest: VendorPrice;
  savingPct: number; // (max - min) / max * 100, 1 decimal; 0 when one vendor
};

const DAY = 86400000;

/* ------------------------------------------------------------------ */
/* Pure functions                                                      */
/* ------------------------------------------------------------------ */

/** lowercase, trim, strip punctuation, collapse spaces. Keeps letters/digits of any script (Urdu). */
export function normalizeItemName(name: string): string {
  return (name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normUnit(unit: string | null | undefined): string | null {
  const u = (unit ?? "").trim().toLowerCase();
  return u === "" ? null : u;
}

export function buildPriceSeries(rows: PurchaseRow[]): PriceSeries[] {
  const map = new Map<string, PriceSeries>();
  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const r of sorted) {
    const normName = normalizeItemName(r.name);
    if (!normName) continue;
    const unit = normUnit(r.unit);
    const key = `${r.vendorId}|${normName}|${unit ?? ""}`;
    let s = map.get(key);
    if (!s) {
      s = {
        key,
        normName,
        name: r.name.trim(),
        unit,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        currency: r.currency,
        points: [],
      };
      map.set(key, s);
    }
    s.name = r.name.trim(); // latest spelling wins
    s.points.push({ date: r.occurredAt, unitPriceMinor: r.unitPriceMinor, qty: r.qty });
  }
  return [...map.values()];
}

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function detectPriceAlerts(
  series: PriceSeries[],
  now: Date = new Date(),
  opts: AlertOptions = {},
): PriceAlert[] {
  const threshold = opts.thresholdPct ?? 5;
  const windowDays = opts.windowDays ?? 90;
  const recentDays = opts.recentDays ?? 90;
  const eps = 1e-9;
  const alerts: PriceAlert[] = [];

  for (const s of series) {
    if (s.points.length < 2) continue;
    const latest = s.points[s.points.length - 1];
    if (now.getTime() - latest.date.getTime() > recentDays * DAY) continue;
    const prior = s.points.slice(0, -1);
    const prev = prior[prior.length - 1];

    const vsPrev = prev.unitPriceMinor > 0 ? pctChange(prev.unitPriceMinor, latest.unitPriceMinor) : 0;

    const windowPts = prior.filter((p) => now.getTime() - p.date.getTime() <= windowDays * DAY);
    let vsAvg = 0;
    let avg = 0;
    if (windowPts.length > 0) {
      avg = windowPts.reduce((a, p) => a + p.unitPriceMinor, 0) / windowPts.length;
      if (avg > 0) vsAvg = pctChange(avg, latest.unitPriceMinor);
    }

    const prevHit = vsPrev >= threshold - eps;
    const avgHit = vsAvg >= threshold - eps;
    if (!prevHit && !avgHit) continue;

    const usePrev = prevHit && (!avgHit || vsPrev >= vsAvg);
    alerts.push({
      key: s.key,
      normName: s.normName,
      name: s.name,
      unit: s.unit,
      vendorId: s.vendorId,
      vendorName: s.vendorName,
      currency: s.currency,
      pct: round1(usePrev ? vsPrev : vsAvg),
      oldMinor: usePrev ? prev.unitPriceMinor : Math.round(avg),
      newMinor: latest.unitPriceMinor,
      since: usePrev ? prev.date : windowPts[0].date,
      date: latest.date,
      basis: usePrev ? "previous" : "average",
    });
  }
  return alerts.sort((a, b) => b.pct - a.pct);
}

export function compareVendors(series: PriceSeries[]): VendorComparison[] {
  const groups = new Map<string, PriceSeries[]>();
  for (const s of series) {
    if (s.points.length === 0) continue;
    const k = `${s.normName}|${s.unit ?? ""}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const out: VendorComparison[] = [];
  for (const g of groups.values()) {
    const vendorsList: VendorPrice[] = g
      .map((s) => {
        const last = s.points[s.points.length - 1];
        return {
          vendorId: s.vendorId,
          vendorName: s.vendorName,
          unitPriceMinor: last.unitPriceMinor,
          date: last.date,
        };
      })
      .sort((a, b) => a.unitPriceMinor - b.unitPriceMinor);
    const cheapest = vendorsList[0];
    const priciest = vendorsList[vendorsList.length - 1];
    const savingPct =
      vendorsList.length > 1 && priciest.unitPriceMinor > 0
        ? round1(((priciest.unitPriceMinor - cheapest.unitPriceMinor) / priciest.unitPriceMinor) * 100)
        : 0;
    const newest = g.reduce((a, b) =>
      a.points[a.points.length - 1].date >= b.points[b.points.length - 1].date ? a : b,
    );
    out.push({
      normName: g[0].normName,
      name: newest.name,
      unit: g[0].unit,
      currency: newest.currency,
      vendors: vendorsList,
      cheapest,
      priciest,
      savingPct,
    });
  }
  return out.sort((a, b) => b.savingPct - a.savingPct || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

/** Confirmed credit (bill) item lines with a unit price. Void/draft are excluded here. */
export async function loadPurchaseRows(
  opts: { vendorId?: number; sinceDays?: number } = {},
): Promise<PurchaseRow[]> {
  const conds = [
    eq(transactions.status, "confirmed"),
    eq(transactions.entryType, "credit"),
    isNotNull(txItems.unitPriceMinor),
    // Only purchases from vendors: customer sales are not prices we pay.
    eq(vendors.kind, "vendor"),
  ];
  if (opts.vendorId !== undefined) conds.push(eq(transactions.vendorId, opts.vendorId));
  if (opts.sinceDays !== undefined) {
    conds.push(gte(transactions.occurredAt, new Date(Date.now() - opts.sinceDays * DAY)));
  }
  const rows = await db
    .select({
      vendorId: transactions.vendorId,
      vendorName: vendors.name,
      currency: vendors.currency,
      name: txItems.name,
      unit: txItems.unit,
      qty: txItems.qty,
      unitPriceMinor: txItems.unitPriceMinor,
      occurredAt: transactions.occurredAt,
    })
    .from(txItems)
    .innerJoin(transactions, eq(txItems.transactionId, transactions.id))
    .innerJoin(vendors, eq(transactions.vendorId, vendors.id))
    .where(and(...conds))
    .orderBy(asc(transactions.occurredAt));
  return rows.map((r) => ({
    ...r,
    unitPriceMinor: Number(r.unitPriceMinor),
    qty: Number(r.qty),
  }));
}

export type ItemSummary = {
  normName: string;
  name: string;
  unit: string | null;
  currency: string;
  purchases: number;
  vendorCount: number;
  latestMinor: number;
  latestDate: Date;
  changePct: number | null; // latest vs previous purchase from the same vendor
};

export type PriceOverview = {
  alerts: PriceAlert[];
  items: ItemSummary[];
  totalItems: number;
};

export async function getPriceOverview(q?: string): Promise<PriceOverview> {
  const rows = await loadPurchaseRows();
  const series = buildPriceSeries(rows);
  const alerts = detectPriceAlerts(series, new Date());

  const groups = new Map<string, PriceSeries[]>();
  for (const s of series) {
    const k = `${s.normName}|${s.unit ?? ""}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  let items: ItemSummary[] = [];
  for (const g of groups.values()) {
    const latestSeries = g.reduce((a, b) =>
      a.points[a.points.length - 1].date >= b.points[b.points.length - 1].date ? a : b,
    );
    const pts = latestSeries.points;
    const last = pts[pts.length - 1];
    const prev = pts.length > 1 ? pts[pts.length - 2] : null;
    items.push({
      normName: g[0].normName,
      name: latestSeries.name,
      unit: g[0].unit,
      currency: latestSeries.currency,
      purchases: g.reduce((a, s) => a + s.points.length, 0),
      vendorCount: g.length,
      latestMinor: last.unitPriceMinor,
      latestDate: last.date,
      changePct:
        prev && prev.unitPriceMinor > 0
          ? round1(pctChange(prev.unitPriceMinor, last.unitPriceMinor))
          : null,
    });
  }
  const totalItems = items.length;
  const nq = q ? normalizeItemName(q) : "";
  if (nq) items = items.filter((i) => i.normName.includes(nq));
  items.sort((a, b) => b.latestDate.getTime() - a.latestDate.getTime());
  const filteredAlerts = nq ? alerts.filter((a) => a.normName.includes(nq)) : alerts;
  return { alerts: filteredAlerts, items, totalItems };
}

export type ItemDetailUnit = {
  unit: string | null;
  currency: string;
  series: PriceSeries[];
  purchases: Array<PurchaseRow>; // newest first
  comparison: VendorComparison | null;
};

export type ItemDetail = {
  normName: string;
  name: string;
  units: ItemDetailUnit[];
};

export async function getItemDetail(name: string): Promise<ItemDetail | null> {
  const norm = normalizeItemName(name);
  if (!norm) return null;
  const rows = (await loadPurchaseRows()).filter((r) => normalizeItemName(r.name) === norm);
  if (rows.length === 0) return null;
  const series = buildPriceSeries(rows);
  const comparisons = compareVendors(series);
  const unitKeys = [...new Set(series.map((s) => s.unit ?? ""))];
  const units: ItemDetailUnit[] = unitKeys.map((uk) => {
    const unit = uk === "" ? null : uk;
    const unitRows = rows
      .filter((r) => normUnit(r.unit) === unit)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return {
      unit,
      currency: unitRows[0].currency,
      series: series.filter((s) => s.unit === unit),
      purchases: unitRows,
      comparison: comparisons.find((c) => c.unit === unit) ?? null,
    };
  });
  const latest = [...rows].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  return { normName: norm, name: latest.name.trim(), units };
}
