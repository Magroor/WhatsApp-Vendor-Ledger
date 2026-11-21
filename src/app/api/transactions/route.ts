import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { paymentAllocations, transactions, txItems, vendors } from "@/db/schema";
import {
  cleanText,
  clientKey,
  fail,
  MAX_AMOUNT_MINOR,
  ok,
  parseDate,
  parseId,
  parsePositiveAmount,
  rateLimit,
  readJsonObject,
} from "@/lib/api";
import { computeDueDate, createLedgerEntry, setTransactionStatus } from "@/lib/ingest";
import { getSettings, logAudit } from "@/lib/settings";
import type { EntryType, ParsedItem } from "@/lib/parse";

export const dynamic = "force-dynamic";
// Manual ledger CRUD: inputs are validated strictly (400 on bad values, never silently coerced).
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendorParam = url.searchParams.get("vendorId");
  const vendorId = parseId(vendorParam);
  const type = url.searchParams.get("type");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const from = parseDate(fromParam);
  const to = parseDate(toParam);
  // A filter that was supplied but cannot be parsed must not silently widen the result.
  if (vendorParam && !vendorId) return fail("invalid vendorId");
  if (type && type !== "credit" && type !== "debit") return fail("type must be credit or debit");
  if (fromParam && !from) return fail("invalid from date");
  if (toParam && !to) return fail("invalid to date");
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIST_LIMIT, rawLimit) : DEFAULT_LIST_LIMIT;

  const filters = [inArray(transactions.status, ["confirmed", "draft"])];
  if (vendorId) filters.push(eq(transactions.vendorId, vendorId));
  if (type === "credit" || type === "debit") filters.push(eq(transactions.entryType, type));
  if (from) filters.push(gte(transactions.occurredAt, from));
  if (to) filters.push(lte(transactions.occurredAt, to));

  const rows = await db
    .select({
      id: transactions.id,
      vendorId: transactions.vendorId,
      vendorName: vendors.name,
      vendorPhone: vendors.phone,
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
      taxMinor: transactions.taxMinor,
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
    .innerJoin(vendors, eq(vendors.id, transactions.vendorId))
    .where(and(...filters))
    .orderBy(desc(transactions.occurredAt))
    .limit(limit);

  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await db.select().from(txItems).where(inArray(txItems.transactionId, ids))
    : [];

  return ok({
    transactions: rows.map((r) => ({
      ...r,
      amountMinor: Number(r.amountMinor),
      taxMinor: Number(r.taxMinor),
      items: items.filter((i) => i.transactionId === r.id),
    })),
  });
}

type CreateBody = {
  vendorId?: unknown;
  entryType?: unknown;
  amount?: unknown;
  description?: unknown;
  reference?: unknown;
  paymentMode?: unknown;
  occurredAt?: unknown;
  dueDate?: unknown;
  status?: unknown;
  source?: unknown;
  items?: Array<{ name?: unknown; qty?: unknown; unit?: unknown; unitPrice?: unknown } | null>;
};

/** Entries may be back-dated freely but not dated more than this far ahead. */
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const MIN_DATE_MS = Date.UTC(1990, 0, 1);

function checkOccurredAt(value: unknown): { ok: true; date: Date | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, date: null };
  const d = parseDate(value);
  if (!d) return { ok: false, error: "occurredAt must be a valid date" };
  if (d.getTime() > Date.now() + MAX_FUTURE_MS || d.getTime() < MIN_DATE_MS) {
    return { ok: false, error: "occurredAt is out of range" };
  }
  return { ok: true, date: d };
}

function checkDueDate(value: unknown): { ok: true; day: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, day: null };
  const d = parseDate(value);
  if (!d || d.getTime() < MIN_DATE_MS || d.getTime() > Date.now() + 10 * MAX_FUTURE_MS) {
    return { ok: false, error: "dueDate must be a valid date" };
  }
  return { ok: true, day: d.toISOString().slice(0, 10) };
}

export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "tx-create"), 60, 60_000)) return fail("rate-limited", 429);
  const read = await readJsonObject<CreateBody>(req);
  if (!read.ok) return fail(read.error, read.status);
  const body = read.body;
  const vendorId = typeof body.vendorId === "number" || typeof body.vendorId === "string"
    ? parseId(String(body.vendorId))
    : null;
  const entryType = body.entryType === "debit" ? "debit" : body.entryType === "credit" ? "credit" : null;
  if (body.vendorId === undefined || body.vendorId === null) return fail("vendorId required");
  if (!vendorId) return fail("vendorId must be a positive integer");
  if (!entryType) return fail("entryType must be credit or debit");
  const amount = parsePositiveAmount(body.amount);
  if (!amount.ok) return fail(amount.error);
  const amountMinor = amount.minor;
  if (body.status !== undefined && body.status !== "draft" && body.status !== "confirmed") {
    return fail("status must be draft or confirmed");
  }
  const when = checkOccurredAt(body.occurredAt);
  if (!when.ok) return fail(when.error);
  const due = checkDueDate(body.dueDate);
  if (!due.ok) return fail(due.error);
  if (body.items !== undefined && body.items !== null && !Array.isArray(body.items)) {
    return fail("items must be an array");
  }
  if (Array.isArray(body.items) && body.items.length > 200) return fail("too many items (max 200)");

  const settings = await getSettings();
  const vendorRow = await db
    .select({ currency: vendors.currency, terms: vendors.creditTermsDays })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  if (!vendorRow[0]) return fail("vendor not found", 404);

  const occurredAt = when.date ?? new Date();
  const parsedItems: ParsedItem[] = [];
  for (const raw of body.items ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const name = cleanText(raw.name, 120);
    const qty = Number(raw.qty ?? 1);
    // Skip unnamed lines and nonsense quantities (0, negative, NaN, absurd).
    if (!name || !Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) continue;
    const price =
      raw.unitPrice === undefined || raw.unitPrice === null || raw.unitPrice === ""
        ? null
        : parsePositiveAmount(raw.unitPrice);
    const unitPriceMinor = price && price.ok ? price.minor : null;
    const line = unitPriceMinor ? Math.round(qty * unitPriceMinor) : null;
    parsedItems.push({
      name,
      qty,
      unit: cleanText(raw.unit, 20),
      unitPriceMinor,
      lineTotalMinor: line !== null && line <= MAX_AMOUNT_MINOR ? line : null,
    });
  }
  const itemsSum = parsedItems.reduce((a, i) => a + (i.lineTotalMinor ?? 0), 0);

  const tx = await createLedgerEntry({
    vendorId,
    entryType: entryType as EntryType,
    amountMinor,
    currency: vendorRow[0].currency,
    description: cleanText(body.description, 2000),
    reference: cleanText(body.reference, 200),
    paymentMode: cleanText(body.paymentMode, 40),
    occurredAt,
    dueDate:
      entryType === "credit"
        ? due.day ?? computeDueDate(occurredAt, vendorRow[0].terms, settings.defaultTermDays)
        : null,
    status: body.status === "draft" ? "draft" : "confirmed",
    source: body.source === "import" ? "import" : "manual",
    subtotalMinor: itemsSum > 0 && itemsSum <= MAX_AMOUNT_MINOR ? itemsSum : null,
    items: parsedItems,
    actor: "user",
  });

  return ok({ transaction: tx }, 201);
}

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const id = parseId(url.searchParams.get("id"));
  if (!id) return fail("id required");
  const read = await readJsonObject<{
    status?: unknown;
    entryType?: unknown;
    amount?: unknown;
    reference?: unknown;
    description?: unknown;
    dueDate?: unknown;
  }>(req);
  if (!read.ok) return fail(read.error, read.status);
  const body = read.body;

  if (body.status !== undefined) {
    if (body.status !== "draft" && body.status !== "confirmed" && body.status !== "void") {
      return fail("status must be draft, confirmed or void");
    }
    const updated = await setTransactionStatus(id, body.status);
    if (!updated) return fail("not found", 404);
    return ok({ transaction: updated });
  }

  const existing = (
    await db
      .select({
        entryType: transactions.entryType,
        occurredAt: transactions.occurredAt,
        dueDate: transactions.dueDate,
        terms: vendors.creditTermsDays,
      })
      .from(transactions)
      .innerJoin(vendors, eq(vendors.id, transactions.vendorId))
      .where(eq(transactions.id, id))
      .limit(1)
  )[0];
  if (!existing) return fail("not found", 404);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.entryType !== undefined) {
    if (body.entryType !== "credit" && body.entryType !== "debit") {
      return fail("entryType must be credit or debit");
    }
    patch.entryType = body.entryType;
  }
  if (body.amount !== undefined) {
    const amount = parsePositiveAmount(body.amount);
    if (!amount.ok) return fail(amount.error);
    patch.amountMinor = amount.minor;
  }
  if (body.reference !== undefined) patch.reference = cleanText(body.reference, 200);
  if (body.description !== undefined) patch.description = cleanText(body.description, 2000);
  if (body.dueDate !== undefined) {
    const due = checkDueDate(body.dueDate);
    if (!due.ok) return fail(due.error);
    patch.dueDate = due.day;
  }
  // Only bills carry a due date: drop it when an entry becomes a payment, and
  // give a payment that becomes a bill the vendor's normal terms.
  const nextType = (patch.entryType as string | undefined) ?? existing.entryType;
  if (nextType === "debit") {
    patch.dueDate = null;
  } else if (nextType === "credit" && existing.entryType !== "credit" && patch.dueDate === undefined && !existing.dueDate) {
    const settings = await getSettings();
    const occurredAt = existing.occurredAt instanceof Date ? existing.occurredAt : new Date(existing.occurredAt);
    patch.dueDate = computeDueDate(occurredAt, existing.terms, settings.defaultTermDays);
  }

  const updated = await db
    .update(transactions)
    .set(patch as never)
    .where(eq(transactions.id, id))
    .returning();
  if (!updated[0]) return fail("not found", 404);

  // Explicit payment->bill allocations must stay consistent with the entry:
  // a type flip invalidates them, and a smaller amount may no longer cover them.
  let allocationsCleared = 0;
  const typeChanged = patch.entryType !== undefined && patch.entryType !== existing.entryType;
  if (typeChanged || patch.amountMinor !== undefined) {
    const links = await db
      .select({ paymentId: paymentAllocations.paymentId, billId: paymentAllocations.billId, amountMinor: paymentAllocations.amountMinor })
      .from(paymentAllocations)
      .where(or(eq(paymentAllocations.paymentId, id), eq(paymentAllocations.billId, id)));
    const asPayment = links.filter((l) => l.paymentId === id).reduce((a, l) => a + Number(l.amountMinor), 0);
    const asBill = links.filter((l) => l.billId === id).reduce((a, l) => a + Number(l.amountMinor), 0);
    const amountNow = Number(updated[0].amountMinor);
    if (links.length && (typeChanged || asPayment > amountNow || asBill > amountNow)) {
      const removed = await db
        .delete(paymentAllocations)
        .where(or(eq(paymentAllocations.paymentId, id), eq(paymentAllocations.billId, id)))
        .returning({ id: paymentAllocations.id });
      allocationsCleared = removed.length;
      await logAudit({
        entityType: "transaction",
        entityId: id,
        action: "allocations.cleared-on-edit",
        actor: "user",
        summary: `Entry ${id} edited; ${removed.length} payment allocation(s) removed`,
      });
    }
  }
  return ok({ transaction: updated[0], allocationsCleared });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = parseId(url.searchParams.get("id"));
  if (!id) return fail("id required");
  // tx_items, payment_allocations cascade; reminders keep the row (set null).
  const deleted = await db
    .delete(transactions)
    .where(eq(transactions.id, id))
    .returning({ id: transactions.id, entryType: transactions.entryType, amountMinor: transactions.amountMinor, currency: transactions.currency });
  if (!deleted[0]) return fail("not found", 404);
  await logAudit({
    entityType: "transaction",
    entityId: id,
    action: "ledger.deleted",
    actor: "user",
    summary: `Entry ${id} deleted (${deleted[0].entryType} ${Number(deleted[0].amountMinor)} minor ${deleted[0].currency})`,
  });
  return ok({ deleted: id });
}
