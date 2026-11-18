import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { transactions, txItems, vendors, waMessages } from "@/db/schema";
import { fail, ok, parseAmountToMinor, parseId, readJson } from "@/lib/api";
import { vendorBalanceMinor } from "@/lib/ingest";
import { logAudit } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const vendorId = parseId(id);
  if (!vendorId) return fail("invalid id");
  const rows = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
  if (!rows[0]) return fail("vendor not found", 404);
  const balance = await vendorBalanceMinor(vendorId);
  const recent = await db
    .select()
    .from(transactions)
    .where(eq(transactions.vendorId, vendorId))
    .orderBy(desc(transactions.occurredAt))
    .limit(50);
  return ok({ vendor: rows[0], balanceMinor: balance, transactions: recent });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const vendorId = parseId(id);
  if (!vendorId) return fail("invalid id");
  const body = await readJson<{
    name?: string;
    phone?: string;
    businessType?: string;
    city?: string;
    currency?: string;
    creditTermsDays?: number;
    openingBalance?: string | number;
    notes?: string;
    archived?: boolean;
    needsReview?: boolean;
  }>(req);

  const patch: Record<string, unknown> = {};
  if (body.name?.trim()) patch.name = body.name.trim();
  if (body.phone !== undefined) patch.phone = body.phone.trim() || null;
  if (body.businessType !== undefined) patch.businessType = body.businessType;
  if (body.city !== undefined) patch.city = body.city;
  if (body.currency) patch.currency = body.currency.toUpperCase();
  if (typeof body.creditTermsDays === "number") patch.creditTermsDays = body.creditTermsDays;
  if (body.openingBalance !== undefined) {
    patch.openingBalanceMinor = parseAmountToMinor(body.openingBalance) ?? 0;
  }
  if (body.notes !== undefined) patch.notes = body.notes;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (typeof body.needsReview === "boolean") patch.needsReview = body.needsReview;

  if (Object.keys(patch).length === 0) return fail("nothing to update");

  const updated = await db
    .update(vendors)
    .set(patch as never)
    .where(eq(vendors.id, vendorId))
    .returning();
  if (!updated[0]) return fail("vendor not found", 404);

  await logAudit({
    entityType: "vendor",
    entityId: vendorId,
    action: "vendor.updated",
    actor: "user",
    summary: `Vendor ${updated[0].name} updated: ${Object.keys(patch).join(", ")}`,
  });
  return ok({ vendor: updated[0] });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const vendorId = parseId(id);
  if (!vendorId) return fail("invalid id");

  const txIds = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.vendorId, vendorId));
  if (txIds.length) {
    await db.delete(txItems).where(
      inArray(
        txItems.transactionId,
        txIds.map((t) => t.id),
      ),
    );
  }
  await db.delete(transactions).where(eq(transactions.vendorId, vendorId));
  await db.delete(waMessages).where(eq(waMessages.vendorId, vendorId));
  const deleted = await db.delete(vendors).where(eq(vendors.id, vendorId)).returning();
  await logAudit({
    entityType: "vendor",
    entityId: vendorId,
    action: "vendor.deleted",
    actor: "user",
    summary: `Vendor ${deleted[0]?.name ?? vendorId} and ledger removed`,
  });
  return ok({ deleted: vendorId });
}
