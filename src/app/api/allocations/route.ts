import { eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentAllocations, transactions, vendors } from "@/db/schema";
import { clientKey, fail, ok, parseId, rateLimit, readJson } from "@/lib/api";
import { availableFromInputs, loadAllocationInputs, loadBillStatuses } from "@/lib/allocations";
import { formatMinor } from "@/lib/money";

export const dynamic = "force-dynamic";

class AllocError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Strict money parse: "1,500", "1500.5", 1500.25 -> minor units. Null for junk / >2 decimals. */
function strictMinor(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const scaled = value * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) return null;
    return rounded;
  }
  if (typeof value === "string") {
    const s = value.replace(/[,\s]/g, "");
    const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!m) return null;
    const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
    return Number.isSafeInteger(minor) ? minor : null;
  }
  return null;
}

const idOf = (v: unknown) => parseId(typeof v === "number" ? String(v) : typeof v === "string" ? v : null);

export async function GET(req: Request) {
  if (!rateLimit(clientKey(req, "alloc-get"), 240, 60_000)) return fail("rate-limited", 429);
  const url = new URL(req.url);
  const vendorId = parseId(url.searchParams.get("vendorId"));
  if (!vendorId) return fail("vendorId required");
  const paymentIdRaw = url.searchParams.get("paymentId");
  const paymentId = paymentIdRaw ? parseId(paymentIdRaw) : null;
  if (paymentIdRaw && !paymentId) return fail("paymentId must be a positive number");

  const input = await loadAllocationInputs(vendorId);
  if (!input) return fail("vendor not found", 404);
  const statuses = await loadBillStatuses(vendorId);
  if (!statuses) return fail("vendor not found", 404);

  let forPayment = null;
  if (paymentId) {
    const pay = input.payments.find((p) => p.id === paymentId);
    if (!pay) return fail("payment not found for this vendor (must be a confirmed payment)", 404);
    const avail = availableFromInputs(paymentId, input);
    forPayment = {
      paymentId,
      amountMinor: pay.amountMinor,
      allocations: input.allocations
        .filter((a) => a.paymentId === paymentId)
        .map((a) => ({ billId: a.billId, amountMinor: a.amountMinor })),
      available: statuses.bills.map((b) => ({ billId: b.billId, availableMinor: avail.get(b.billId) ?? 0 })),
    };
  }

  return ok({
    vendorId,
    currency: statuses.currency,
    bills: statuses.bills,
    payments: statuses.payments,
    openingOpenMinor: statuses.openingOpenMinor,
    advanceMinor: statuses.advanceMinor,
    totalOpenMinor: statuses.totalOpenMinor,
    forPayment,
  });
}

type PostBody = { paymentId?: unknown; allocations?: unknown };

export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "alloc-post"), 120, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<PostBody>(req);
  const paymentId = idOf(body.paymentId);
  if (!paymentId) return fail("paymentId required");
  if (!Array.isArray(body.allocations)) return fail("allocations must be a list of {billId, amount}");
  if (body.allocations.length > 200) return fail("too many allocations (max 200)");

  const wanted: Array<{ billId: number; amountMinor: number }> = [];
  const seen = new Set<number>();
  for (const [i, raw] of body.allocations.entries()) {
    const item = (raw ?? {}) as { billId?: unknown; amount?: unknown };
    const billId = idOf(item.billId);
    if (!billId) return fail(`allocations[${i}].billId required`);
    if (seen.has(billId)) return fail(`bill ${billId} is listed twice`);
    seen.add(billId);
    const amountMinor = strictMinor(item.amount);
    if (amountMinor === null) return fail(`allocations[${i}].amount must be a number with at most 2 decimals`);
    if (amountMinor <= 0) return fail(`allocations[${i}].amount must be more than 0`);
    wanted.push({ billId, amountMinor });
  }

  try {
    const result = await db.transaction(async (trx) => {
      const pay = await trx
        .select({ id: transactions.id, vendorId: transactions.vendorId })
        .from(transactions)
        .where(eq(transactions.id, paymentId))
        .limit(1);
      if (!pay[0]) throw new AllocError("payment not found", 404);
      const vendorId = pay[0].vendorId;

      // One lock per vendor: every allocation write for this vendor runs one after another, so
      // two parallel requests cannot both see the same open amount on a bill.
      await trx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).for("no key update");

      const input = await loadAllocationInputs(vendorId, trx);
      if (!input) throw new AllocError("vendor not found", 404);
      const payment = input.payments.find((p) => p.id === paymentId);
      if (!payment) throw new AllocError("entry is not a confirmed payment (debit); void/draft entries cannot be applied", 400);

      const billIds = new Set(input.bills.map((b) => b.id));
      const missing = wanted.filter((w) => !billIds.has(w.billId)).map((w) => w.billId);
      if (missing.length) {
        const found = await trx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.id, missing[0]))
          .limit(1);
        if (!found[0]) throw new AllocError(`bill ${missing[0]} not found`, 404);
        throw new AllocError(`entry ${missing[0]} is not a confirmed bill (credit) of the same vendor`, 400);
      }

      const total = wanted.reduce((a, w) => a + w.amountMinor, 0);
      if (total > payment.amountMinor) {
        throw new AllocError(
          `total ${formatMinor(total, input.currency)} is more than the payment ${formatMinor(payment.amountMinor, input.currency)}`,
          400,
        );
      }
      const available = availableFromInputs(paymentId, input);
      for (const w of wanted) {
        const cap = available.get(w.billId) ?? 0;
        if (w.amountMinor > cap) {
          throw new AllocError(
            `bill ${w.billId}: only ${formatMinor(cap, input.currency)} can still be applied (other payments already cover the rest), not ${formatMinor(w.amountMinor, input.currency)}`,
            400,
          );
        }
      }

      await trx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId));
      if (wanted.length) {
        await trx
          .insert(paymentAllocations)
          .values(wanted.map((w) => ({ paymentId, billId: w.billId, amountMinor: w.amountMinor })));
      }
      return { vendorId, allocatedMinor: total };
    });

    const statuses = await loadBillStatuses(result.vendorId);
    return ok({
      paymentId,
      allocations: wanted,
      allocatedMinor: result.allocatedMinor,
      bills: statuses?.bills ?? [],
      payments: statuses?.payments ?? [],
    });
  } catch (e) {
    if (e instanceof AllocError) return fail(e.message, e.status);
    throw e;
  }
}

export async function DELETE(req: Request) {
  if (!rateLimit(clientKey(req, "alloc-del"), 120, 60_000)) return fail("rate-limited", 429);
  const url = new URL(req.url);
  const paymentId = parseId(url.searchParams.get("paymentId"));
  if (!paymentId) return fail("paymentId required");
  const pay = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, paymentId)).limit(1);
  if (!pay[0]) return fail("payment not found", 404);
  const deleted = await db
    .delete(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, paymentId))
    .returning({ id: paymentAllocations.id });
  return ok({ paymentId, deleted: deleted.length });
}
