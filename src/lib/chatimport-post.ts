import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors, waMessages } from "@/db/schema";
import { draftsFromChat, parseChatExport } from "./chatimport";
import { postParsedDraft } from "./ingest";
import { getSettings } from "./settings";
import { getUnassignedVendorId, matchVendorByChatTitle } from "./vendormatch";

export type ImportResult = {
  found: number;
  imported: number;
  duplicates: number;
  drafts: number;
  vendorId: number;
  vendorName: string;
  createdVendor: boolean;
};

/** "WhatsApp Chat - Ahmed Traders.zip" / "WhatsApp Chat with Ahmed Traders.txt" -> "Ahmed Traders". */
export function vendorNameFromFileName(fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.replace(/\.(zip|txt)$/i, "").trim();
  const m = base.match(/^whatsapp\s+chat\s*(?:-|–|with)\s*(.+)$/i);
  const name = (m ? m[1] : "").trim();
  return name.length >= 2 ? name.slice(0, 80) : null;
}

/**
 * Post the bills/payments found in an exported chat to one vendor. Idempotent:
 * every message has a stable hash, so importing the same chat (or a longer
 * export of it) again only adds what is new.
 */
export async function postChatImport(input: {
  text: string;
  vendorId?: number | null;
  /** Used when no vendorId: matched to a saved vendor, otherwise a new vendor is created. */
  vendorName?: string | null;
  vendorPhone?: string | null;
  skip?: Set<string>;
  dayFirst?: boolean;
}): Promise<ImportResult | { error: string }> {
  const lines = parseChatExport(input.text, { dayFirst: input.dayFirst });
  if (lines.length === 0) {
    return { error: "This doesn't look like a WhatsApp exported chat." };
  }
  const settings = await getSettings();
  const entries = draftsFromChat(lines, { currency: settings.currency, defaultTermDays: settings.defaultTermDays });
  const postable = entries.filter((e) => e.postable);

  let vendorId = input.vendorId ?? null;
  let createdVendor = false;
  if (vendorId) {
    const exists = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!exists[0]) vendorId = null;
  }
  if (!vendorId && input.vendorName) vendorId = await matchVendorByChatTitle(input.vendorName);
  if (!vendorId && input.vendorName) {
    const created = await db
      .insert(vendors)
      .values({
        name: input.vendorName.trim(),
        phone: input.vendorPhone?.trim() || null,
        currency: settings.currency,
        creditTermsDays: settings.defaultTermDays,
        autoCreateSource: "import",
        needsReview: true,
      })
      .returning({ id: vendors.id });
    vendorId = created[0].id;
    createdVendor = true;
  }
  const unassigned = !vendorId;
  if (!vendorId) vendorId = await getUnassignedVendorId(settings.currency);
  const vendor = (await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1))[0];

  let imported = 0;
  let duplicates = 0;
  let drafts = 0;
  for (const e of postable) {
    if (input.skip?.has(e.hash)) continue;
    const inserted = await db
      .insert(waMessages)
      .values({
        waMessageId: `import-${vendor.id}-${e.hash}`,
        vendorId: vendor.id,
        direction: "in",
        messageType: "text",
        body: e.text,
        fromPhone: vendor.phone,
        profileName: e.sender,
        receivedAt: e.at,
        parseStatus: "parsed",
        parseConfidence: e.draft.confidence,
        parsePayload: e.draft as never,
        extractionSource: "import",
      })
      .onConflictDoNothing()
      .returning({ id: waMessages.id });
    if (!inserted[0]) {
      duplicates += 1;
      continue;
    }
    const tx = await postParsedDraft({
      draft: e.draft,
      vendorId: vendor.id,
      currency: vendor.currency,
      defaultTermDays: vendor.creditTermsDays,
      autoConfirmThreshold: settings.autoConfirmThreshold,
      messageId: inserted[0].id,
      source: "import",
      actor: "import",
      occurredAtFallback: e.at,
      status: unassigned ? "draft" : undefined,
    });
    if (tx && tx.status !== "confirmed") {
      drafts += 1;
      await db.update(waMessages).set({ parseStatus: "review" }).where(eq(waMessages.id, inserted[0].id));
    }
    imported += 1;
  }
  return { found: postable.length, imported, duplicates, drafts, vendorId: vendor.id, vendorName: vendor.name, createdVendor };
}
