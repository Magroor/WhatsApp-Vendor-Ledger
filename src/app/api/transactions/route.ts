import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { transactions, txItems, vendors } from "@/db/schema";
import {
  clientKey,
  fail,
  ok,
  parseAmountToMinor,
  parseDate,
  parseDateString,
  parseId,
  rateLimit,
  readJson,
} from "@/lib/api";
import { computeDueDate, createLedgerEntry, setTransactionStatus } from "@/lib/ingest";
import { getSettings } from "@/lib/settings";
import type { EntryType, ParsedItem } from "@/lib/parse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendorId = parseId(url.searchParams.get("vendorId"));
  const type = url.searchParams.get("type");
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const limit = Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100);

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
  vendorId?: number;
  entryType?: string;
  amount?: string | number;
  description?: string;
  reference?: string;
  paymentMode?: string;
  occurredAt?: string;
  dueDate?: string;
  status?: string;
  source?: string;
  items?: Array<{ name?: string; qty?: number; unit?: string; unitPrice?: string | number }>;
};

export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "tx-create"), 60, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<CreateBody>(req);
  const vendorId = body.vendorId;
  const entryType = body.entryType === "debit" ? "debit" : body.entryType === "credit" ? "credit" : null;
  const amountMinor = parseAmountToMinor(body.amount);
  if (!vendorId) return fail("vendorId required");
  if (!entryType) return fail("entryType must be credit or debit");
  if (!amountMinor) return fail("amount required");

  const settings = await getSettings();
  const vendorRow = await db
    .select({ currency: vendors.currency, terms: vendors.creditTermsDays })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  if (!vendorRow[0]) return fail("vendor not found", 404);

  const occurredAt = parseDate(body.occurredAt) ?? new Date();
  const parsedItems: ParsedItem[] = (body.items ?? [])
    .filter((i) => i.name && Number(i.qty) > 0)
    .map((i) => {
      const unitPriceMinor = parseAmountToMinor(i.unitPrice) ?? 0;
      const qty = Number(i.qty) || 1;
      return {
        name: String(i.name).slice(0, 120),
        qty,
        unit: i.unit ?? null,
        unitPriceMinor: unitPriceMinor || null,
        lineTotalMinor: unitPriceMinor ? Math.round(qty * unitPriceMinor) : null,
      };
    });
  const itemsSum = parsedItems.reduce((a, i) => a + (i.lineTotalMinor ?? 0), 0);

  const tx = await createLedgerEntry({
    vendorId,
    entryType: entryType as EntryType,
    amountMinor,
    currency: vendorRow[0].currency,
    description: body.description ?? null,
    reference: body.reference ?? null,
    paymentMode: body.paymentMode ?? null,
    occurredAt,
    dueDate:
      entryType === "credit"
        ? parseDateString(body.dueDate) ??
          computeDueDate(occurredAt, vendorRow[0].terms, settings.defaultTermDays)
        : null,
    status: body.status === "draft" ? "draft" : "confirmed",
    source: body.source === "import" ? "import" : "manual",
    subtotalMinor: itemsSum > 0 ? itemsSum : null,
    items: parsedItems,
    actor: "user",
  });

  return ok({ transaction: tx }, 201);
}

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const id = parseId(url.searchParams.get("id"));
  if (!id) return fail("id required");
  const body = await readJson<{
    status?: string;
    entryType?: string;
    amount?: string | number;
    reference?: string;
    description?: string;
    dueDate?: string;
  }>(req);

  if (body.status && ["draft", "confirmed", "void"].includes(body.status)) {
    const updated = await setTransactionStatus(
      id,
      body.status as "draft" | "confirmed" | "void",
    );
    if (!updated) return fail("not found", 404);
    return ok({ transaction: updated });
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.entryType === "credit" || body.entryType === "debit") patch.entryType = body.entryType;
  const amount = body.amount !== undefined ? parseAmountToMinor(body.amount) : null;
  if (amount) patch.amountMinor = amount;
  if (body.reference !== undefined) patch.reference = body.reference;
  if (body.description !== undefined) patch.description = body.description;
  if (body.dueDate !== undefined) patch.dueDate = parseDateString(body.dueDate);

  const updated = await db
    .update(transactions)
    .set(patch as never)
    .where(eq(transactions.id, id))
    .returning();
  if (!updated[0]) return fail("not found", 404);
  return ok({ transaction: updated[0] });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = parseId(url.searchParams.get("id"));
  if (!id) return fail("id required");
  await db.delete(transactions).where(eq(transactions.id, id));
  return ok({ deleted: id });
}
