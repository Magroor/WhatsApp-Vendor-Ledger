import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { transactions } from "@/db/schema";

const DAY = 86_400_000;

/**
 * An earlier entry that looks like the same bill: same vendor, same direction, same amount,
 * within 3 days either way, not voided. A repeat is common: the vendor sends the bill as a
 * photo AND as a typed message, or it is forwarded twice. Shown as a warning, never blocked.
 */
export async function findLikelyDuplicate(tx: {
  id: number;
  vendorId: number;
  entryType: string;
  amountMinor: number;
  occurredAt: Date;
}): Promise<{ id: number; occurredAt: Date; status: string } | null> {
  const rows = await db
    .select({ id: transactions.id, occurredAt: transactions.occurredAt, status: transactions.status })
    .from(transactions)
    .where(
      and(
        eq(transactions.vendorId, tx.vendorId),
        eq(transactions.entryType, tx.entryType),
        eq(transactions.amountMinor, tx.amountMinor),
        ne(transactions.status, "void"),
        ne(transactions.id, tx.id),
        gte(transactions.occurredAt, new Date(tx.occurredAt.getTime() - 3 * DAY)),
        lte(transactions.occurredAt, new Date(tx.occurredAt.getTime() + 3 * DAY)),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(1);
  return rows[0] ?? null;
}
