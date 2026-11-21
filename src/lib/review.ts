import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { transactions, vendors, waMessages } from "@/db/schema";
import { logAudit } from "./settings";

export type ReviewItem = {
  messageId: number;
  transactionId: number | null;
  vendorId: number | null;
  vendorName: string | null;
  messageType: string;
  text: string;
  amountMinor: number | null;
  entryType: "credit" | "debit" | null;
  currency: string;
  confidence: number;
  receivedAt: Date;
  hasMedia: boolean;
  assumedDirection: boolean;
  clean: boolean;
};

const CLEAN_MIN_CONFIDENCE = 65;

/**
 * Everything waiting for a person: messages marked "review" and entries saved as drafts.
 * "Clean" = a draft with a known vendor, a stated direction, an amount, and nothing odd
 * (the lines add up, confidence is reasonable): safe to confirm in bulk.
 */
export async function getReviewItems(limit = 40): Promise<ReviewItem[]> {
  const rows = await db
    .select({
      messageId: waMessages.id,
      messageType: waMessages.messageType,
      body: waMessages.body,
      caption: waMessages.caption,
      ocrText: waMessages.ocrText,
      mediaId: waMessages.mediaId,
      receivedAt: waMessages.receivedAt,
      parseStatus: waMessages.parseStatus,
      parseConfidence: waMessages.parseConfidence,
      parsePayload: waMessages.parsePayload,
      vendorId: waMessages.vendorId,
      vendorName: vendors.name,
      transactionId: transactions.id,
      txType: transactions.entryType,
      txAmount: transactions.amountMinor,
      txStatus: transactions.status,
      txCurrency: transactions.currency,
      txConfidence: transactions.confidence,
    })
    .from(waMessages)
    .leftJoin(vendors, eq(vendors.id, waMessages.vendorId))
    .leftJoin(transactions, eq(transactions.messageId, waMessages.id))
    .where(
      and(
        eq(waMessages.direction, "in"),
        ne(waMessages.parseStatus, "ignored"),
        or(eq(waMessages.parseStatus, "review"), eq(transactions.status, "draft")),
      ),
    )
    .orderBy(desc(waMessages.receivedAt))
    .limit(limit);

  return rows
    .filter((r) => r.txStatus !== "void")
    .map((r) => {
      const payload = (r.parsePayload ?? {}) as { amountMinor?: number | null; entryType?: string | null; notes?: string[] };
      const amountMinor = r.txAmount !== null ? Number(r.txAmount) : typeof payload.amountMinor === "number" ? payload.amountMinor : null;
      const entryType = r.txType === "credit" || r.txType === "debit" ? r.txType : null;
      const notes = payload.notes ?? [];
      const assumedDirection = notes.includes("direction-assumed-credit") || (!entryType && !payload.entryType);
      const unassigned = !r.vendorId || (r.vendorName ?? "").startsWith("Unassigned");
      const confidence = r.txConfidence ?? r.parseConfidence;
      const clean =
        r.txStatus === "draft" &&
        !unassigned &&
        !assumedDirection &&
        amountMinor !== null &&
        amountMinor > 0 &&
        confidence >= CLEAN_MIN_CONFIDENCE &&
        !notes.includes("items-sum-differs-from-total");
      return {
        messageId: r.messageId,
        transactionId: r.transactionId,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        messageType: r.messageType,
        text: (r.body ?? r.caption ?? r.ocrText ?? "").slice(0, 220),
        amountMinor,
        entryType,
        currency: r.txCurrency ?? "PKR",
        confidence,
        receivedAt: r.receivedAt,
        hasMedia: Boolean(r.mediaId) && ["image", "document"].includes(r.messageType),
        assumedDirection,
        clean,
      };
    });
}

/** Confirm every clean draft in one go. Returns how many were confirmed. */
export async function confirmCleanDrafts(): Promise<number> {
  const clean = (await getReviewItems(200)).filter((i) => i.clean && i.transactionId);
  const txIds = clean.map((i) => i.transactionId as number);
  const msgIds = clean.map((i) => i.messageId);
  if (!txIds.length) return 0;
  await db.update(transactions).set({ status: "confirmed", updatedAt: new Date() }).where(and(inArray(transactions.id, txIds), eq(transactions.status, "draft")));
  await db.update(waMessages).set({ parseStatus: "parsed" }).where(inArray(waMessages.id, msgIds));
  await logAudit({
    entityType: "transaction",
    action: "ledger.bulk-confirmed",
    actor: "reviewer",
    summary: `Confirmed ${txIds.length} clean draft entries from the review queue`,
    payload: { ids: txIds },
  });
  return txIds.length;
}
