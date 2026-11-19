import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { transactions, txItems, vendors, waMessages } from "@/db/schema";
import { dashboardStats, vendorBalanceMinor } from "./ingest";
import {
  buildReport,
  computeOpenLots,
  loadLedgerRows,
  loadOpeningBalances,
  parseAnchor,
  periodRange,
  type PeriodType,
} from "./reports";
import { getSettings, type AppSettingsShape } from "./settings";
import { resolveTimeZone } from "./time";

/** Business timezone: app setting `timeZone` -> env BUSINESS_TIMEZONE -> Asia/Karachi. */
export function businessTimeZone(settings?: Partial<AppSettingsShape> | null): string {
  return resolveTimeZone((settings as { timeZone?: unknown } | null | undefined)?.timeZone);
}

export async function getDashboard() {
  const [settings, stats] = await Promise.all([getSettings(), dashboardStats()]);
  const tz = businessTimeZone(settings);
  // Started now so they run alongside the week query instead of after it.
  const recentP = Promise.resolve(
    db
    .select({
      id: transactions.id,
      vendorId: transactions.vendorId,
      vendorName: vendors.name,
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      occurredAt: transactions.occurredAt,
      reference: transactions.reference,
      description: transactions.description,
      status: transactions.status,
      source: transactions.source,
      confidence: transactions.confidence,
    })
    .from(transactions)
    .innerJoin(vendors, eq(vendors.id, transactions.vendorId))
    .where(inArray(transactions.status, ["confirmed", "draft"]))
    .orderBy(desc(transactions.occurredAt))
    .limit(6),
  );
  const inboxP = Promise.resolve(
    db
    .select({
      id: waMessages.id,
      vendorId: waMessages.vendorId,
      vendorName: vendors.name,
      body: waMessages.body,
      messageType: waMessages.messageType,
      parseStatus: waMessages.parseStatus,
      parseConfidence: waMessages.parseConfidence,
      receivedAt: waMessages.receivedAt,
      profileName: waMessages.profileName,
    })
    .from(waMessages)
    .leftJoin(vendors, eq(vendors.id, waMessages.vendorId))
    .orderBy(desc(waMessages.receivedAt))
    .limit(5),
  );
  const week = periodRange("weekly", new Date(), tz);
  const weekRows = await loadLedgerRows({ start: week.start, endExclusive: week.endExclusive });
  const totals = weekRows.reduce(
    (acc, r) => {
      if (r.entryType === "credit") acc.credit += r.amountMinor;
      else acc.debit += r.amountMinor;
      return acc;
    },
    { credit: 0, debit: 0 },
  );

  const payable = stats.vendors
    .filter((v) => v.balanceMinor > 0)
    .reduce((a, v) => a + v.balanceMinor, 0);
  const receivable = stats.vendors
    .filter((v) => v.balanceMinor < 0)
    .reduce((a, v) => a + Math.abs(v.balanceMinor), 0);

  const recent = await recentP;

  const inbox = await inboxP;

  const topVendors = [...stats.vendors]
    .sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor))
    .slice(0, 4);

  return {
    settings,
    stats,
    week: { ...week, creditMinor: totals.credit, debitMinor: totals.debit, netMinor: totals.credit - totals.debit },
    payableMinor: payable,
    receivableMinor: receivable,
    recent: recent.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) })),
    inbox,
    topVendors,
  };
}

export async function getVendorsList(query?: string) {
  // All five reads are independent: run them together (one round trip of latency).
  const [settings, stats, rows, openings, messageCounts] = await Promise.all([
    getSettings(),
    dashboardStats(),
    loadLedgerRows({ statuses: ["confirmed"] }),
    loadOpeningBalances(),
    db
    .select({
      vendorId: waMessages.vendorId,
      count: sql<number>`count(*)::int`,
      pending: sql<number>`sum(case when ${waMessages.parseStatus} in ('pending','review') then 1 else 0 end)::int`,
    })
    .from(waMessages)
    .groupBy(waMessages.vendorId),
  ]);
  const lots = computeOpenLots(rows, new Date(), { openings, timeZone: businessTimeZone(settings) });
  const overdueByVendor = new Map<number, { amountMinor: number; oldestDays: number }>();
  for (const lot of lots) {
    const entry = overdueByVendor.get(lot.vendorId) ?? { amountMinor: 0, oldestDays: 0 };
    entry.amountMinor += lot.remainingMinor;
    entry.oldestDays = Math.max(entry.oldestDays, lot.ageDays);
    overdueByVendor.set(lot.vendorId, entry);
  }


  const q = query?.trim().toLowerCase();
  const list = stats.vendors
    .filter((v) =>
      q
        ? v.name.toLowerCase().includes(q) || (v.phone ?? "").includes(q.replace(/\D/g, ""))
        : true,
    )
    .map((v) => {
      const overdue = overdueByVendor.get(v.id);
      const msgs = messageCounts.find((m) => m.vendorId === v.id);
      const terms = v.creditTermsDays || settings.defaultTermDays;
      return {
        ...v,
        openAmountMinor: overdue?.amountMinor ?? 0,
        oldestDays: overdue?.oldestDays ?? 0,
        overdueDays: Math.max(0, (overdue?.oldestDays ?? 0) - terms),
        messageCount: msgs?.count ?? 0,
        pendingMessages: msgs?.pending ?? 0,
      };
    })
    .sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor));

  return {
    settings,
    vendors: list,
    totals: {
      payable: list.filter((v) => v.balanceMinor > 0).reduce((a, v) => a + v.balanceMinor, 0),
      receivable: list.filter((v) => v.balanceMinor < 0).reduce((a, v) => a + Math.abs(v.balanceMinor), 0),
      overdue: list.reduce((a, v) => a + v.openAmountMinor, 0),
    },
  };
}

export async function getVendorPeriodTotals(
  vendorId: number,
  timeZone?: string,
  preloadedRows?: Awaited<ReturnType<typeof loadLedgerRows>>,
) {
  const now = new Date();
  const tz = timeZone ?? businessTimeZone(await getSettings());
  const ranges = {
    weekly: periodRange("weekly", now, tz),
    monthly: periodRange("monthly", now, tz),
    yearly: periodRange("yearly", now, tz),
  };
  const rows = preloadedRows ?? (await loadLedgerRows({ vendorId, statuses: ["confirmed"] }));
  const buckets: Record<keyof typeof ranges, { creditMinor: number; debitMinor: number; count: number }> = {
    weekly: { creditMinor: 0, debitMinor: 0, count: 0 },
    monthly: { creditMinor: 0, debitMinor: 0, count: 0 },
    yearly: { creditMinor: 0, debitMinor: 0, count: 0 },
  };
  for (const row of rows) {
    for (const key of ["weekly", "monthly", "yearly"] as const) {
      const range = ranges[key];
      if (row.vendorId !== vendorId) continue;
      if (row.occurredAt >= range.start && row.occurredAt < range.endExclusive) {
        if (row.entryType === "credit") buckets[key].creditMinor += row.amountMinor;
        else buckets[key].debitMinor += row.amountMinor;
        buckets[key].count += 1;
      }
    }
  }
  return { ranges, buckets };
}

export async function getVendorDetail(vendorId: number, filter: "all" | "credit" | "debit") {
  const rows = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
  const vendor = rows[0];
  if (!vendor) return null;

  const balanceMinor = await vendorBalanceMinor(vendorId);
  const filters = [eq(transactions.vendorId, vendorId), inArray(transactions.status, ["confirmed", "draft"])];
  if (filter !== "all") filters.push(eq(transactions.entryType, filter));

  const txRows = await db
    .select({
      id: transactions.id,
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      description: transactions.description,
      reference: transactions.reference,
      paymentMode: transactions.paymentMode,
      occurredAt: transactions.occurredAt,
      dueDate: transactions.dueDate,
      status: transactions.status,
      source: transactions.source,
      confidence: transactions.confidence,
      messageId: transactions.messageId,
    })
    .from(transactions)
    .where(and(...filters))
    .orderBy(desc(transactions.occurredAt))
    .limit(60);

  const ids = txRows.map((t) => t.id);
  const items = ids.length
    ? await db.select().from(txItems).where(inArray(txItems.transactionId, ids))
    : [];

  const timeZone = businessTimeZone(await getSettings());
  const [ledgerRows, openings] = await Promise.all([
    loadLedgerRows({ vendorId, statuses: ["confirmed"] }),
    loadOpeningBalances(vendorId),
  ]);
  const lots = computeOpenLots(ledgerRows, new Date(), { openings, timeZone });
  const { buckets, ranges } = await getVendorPeriodTotals(vendorId, timeZone, ledgerRows);

  const messages = await db
    .select({
      id: waMessages.id,
      body: waMessages.body,
      messageType: waMessages.messageType,
      parseStatus: waMessages.parseStatus,
      receivedAt: waMessages.receivedAt,
      parseConfidence: waMessages.parseConfidence,
    })
    .from(waMessages)
    .where(eq(waMessages.vendorId, vendorId))
    .orderBy(desc(waMessages.receivedAt))
    .limit(8);

  const totals = ledgerRows.reduce(
    (acc, r) => {
      if (r.entryType === "credit") acc.credit += r.amountMinor;
      else acc.debit += r.amountMinor;
      return acc;
    },
    { credit: 0, debit: 0 },
  );

  return {
    vendor: { ...vendor, openingBalanceMinor: Number(vendor.openingBalanceMinor ?? 0) },
    balanceMinor,
    totals,
    timeZone,
    periodTotals: buckets,
    periodLabels: {
      weekly: ranges.weekly.label,
      monthly: ranges.monthly.label,
      yearly: ranges.yearly.label,
    },
    transactions: txRows.map((t) => ({
      ...t,
      amountMinor: Number(t.amountMinor),
      items: items
        .filter((i) => i.transactionId === t.id)
        .map((i) => ({
          id: i.id,
          name: i.name,
          qty: Number(i.qty ?? 0),
          unit: i.unit,
          unitPriceMinor: Number(i.unitPriceMinor ?? 0),
          lineTotalMinor: Number(i.lineTotalMinor ?? 0),
        })),
    })),
    openLots: lots.sort((a, b) => b.remainingMinor - a.remainingMinor),
    messages,
  };
}

export async function getInbox(status?: string) {
  const filters = [];
  if (status && status !== "all") {
    filters.push(
      status === "pending"
        ? inArray(waMessages.parseStatus, ["pending", "review"])
        : eq(waMessages.parseStatus, status),
    );
  }

  const rows = await db
    .select({
      id: waMessages.id,
      waMessageId: waMessages.waMessageId,
      vendorId: waMessages.vendorId,
      vendorName: vendors.name,
      vendorPhone: vendors.phone,
      direction: waMessages.direction,
      messageType: waMessages.messageType,
      body: waMessages.body,
      caption: waMessages.caption,
      ocrText: waMessages.ocrText,
      mediaId: waMessages.mediaId,
      mimeType: waMessages.mimeType,
      profileName: waMessages.profileName,
      fromPhone: waMessages.fromPhone,
      receivedAt: waMessages.receivedAt,
      parseStatus: waMessages.parseStatus,
      parseConfidence: waMessages.parseConfidence,
      extractionSource: waMessages.extractionSource,
      parsePayload: waMessages.parsePayload,
      transactionId: transactions.id,
      txEntryType: transactions.entryType,
      txAmountMinor: transactions.amountMinor,
      txStatus: transactions.status,
      txCurrency: transactions.currency,
    })
    .from(waMessages)
    .leftJoin(vendors, eq(vendors.id, waMessages.vendorId))
    .leftJoin(transactions, eq(transactions.messageId, waMessages.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(waMessages.receivedAt))
    .limit(60);

  const counts = await db
    .select({ status: waMessages.parseStatus, count: sql<number>`count(*)::int` })
    .from(waMessages)
    .groupBy(waMessages.parseStatus);

  const queueCounts = await db
    .select({ status: sql<string>`status`, count: sql<number>`count(*)::int` })
    .from(sql`sync_queue`)
    .groupBy(sql`status`);

  const list = rows.map((r) => ({
    ...r,
    txAmountMinor: r.txAmountMinor === null ? null : Number(r.txAmountMinor),
  }));

  return {
    messages: list,
    counts,
    queueCounts,
    vendors: (await db.select({ id: vendors.id, name: vendors.name, phone: vendors.phone }).from(vendors).orderBy(vendors.name)).map((v) => ({
      ...v,
    })),
  };
}

/**
 * Report for the reports + print pages. `anchor` may be a Date or the raw
 * query value ("YYYY-MM-DD" is read as a business-timezone calendar date).
 */
export async function getReportPage(
  period: PeriodType,
  anchor?: Date | string | null,
  vendorId?: number,
) {
  const settings = await getSettings();
  const timeZone = businessTimeZone(settings);
  const parsed =
    anchor instanceof Date ? (Number.isNaN(anchor.getTime()) ? null : anchor) : parseAnchor(anchor, timeZone);
  const report = await buildReport({
    type: period,
    anchor: parsed ?? new Date(),
    vendorId: vendorId && Number.isFinite(vendorId) && vendorId > 0 ? vendorId : undefined,
    currency: settings.currency,
    timeZone,
  });
  return { settings, report, timeZone };
}

/** Lightweight vendor list for the report vendor picker. */
export async function getVendorOptions() {
  return db
    .select({ id: vendors.id, name: vendors.name, archived: vendors.archived })
    .from(vendors)
    .orderBy(vendors.name);
}

export async function getAuditTrail(limit = 12) {
  const rows = await db.execute(
    sql`select entity_type, entity_id, action, actor, summary, created_at from audit_events order by created_at desc limit ${limit}`,
  );
  return (rows.rows ?? []) as Array<{
    entity_type: string;
    entity_id: number | null;
    action: string;
    actor: string;
    summary: string | null;
    created_at: string;
  }>;
}

export async function getPendingReviewCount() {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waMessages)
    .where(inArray(waMessages.parseStatus, ["pending", "review"]));
  return rows[0]?.count ?? 0;
}

export async function getStaleMessageCount() {
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waMessages)
    .where(and(lt(waMessages.receivedAt, cutoff), gte(waMessages.id, 0)));
  return rows[0]?.count ?? 0;
}
