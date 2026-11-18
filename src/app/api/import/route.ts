import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors, waMessages } from "@/db/schema";
import { clientKey, fail, ok, rateLimit, readJson } from "@/lib/api";
import { draftsFromChat, parseChatExport } from "@/lib/chatimport";
import { postParsedDraft } from "@/lib/ingest";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Body = {
  vendorId?: number;
  newVendorName?: string;
  newVendorPhone?: string;
  text?: string;
  dayFirst?: boolean;
  commit?: boolean;
  /** hashes the user unticked in the preview */
  skip?: string[];
};

/**
 * Import a WhatsApp "Export chat" file for one vendor.
 * commit=false -> preview only (nothing is written).
 */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "import"), 20, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<Body>(req);
  const text = (body.text ?? "").slice(0, 3_000_000);
  if (!text.trim()) return fail("Choose a chat file or paste the chat text first.");

  const lines = parseChatExport(text, { dayFirst: body.dayFirst });
  if (lines.length === 0) {
    return fail(
      "This doesn't look like a WhatsApp exported chat. In WhatsApp open the chat → ⋯ / contact name → Export Chat → Without Media.",
    );
  }

  const settings = await getSettings();
  const entries = draftsFromChat(lines, {
    currency: settings.currency,
    defaultTermDays: settings.defaultTermDays,
  });
  const postable = entries.filter((e) => e.postable);

  if (!body.commit) {
    return ok({
      totalMessages: entries.length,
      found: postable.length,
      entries: postable.slice(0, 500).map((e) => ({
        hash: e.hash,
        at: e.at.toISOString(),
        sender: e.sender,
        text: e.text.slice(0, 240),
        entryType: e.draft.entryType,
        amountMinor: e.draft.amountMinor,
        confidence: e.draft.confidence,
        items: e.draft.items.length,
      })),
    });
  }

  let vendorId = body.vendorId ?? null;
  if (!vendorId) {
    const name = body.newVendorName?.trim();
    if (!name) return fail("Pick a vendor or type a new vendor name.");
    const created = await db
      .insert(vendors)
      .values({
        name,
        phone: body.newVendorPhone?.trim() || null,
        currency: settings.currency,
        creditTermsDays: settings.defaultTermDays,
        autoCreateSource: "import",
      })
      .returning();
    vendorId = created[0].id;
  }
  const vendorRow = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
  const vendor = vendorRow[0];
  if (!vendor) return fail("vendor not found", 404);

  const skip = new Set(body.skip ?? []);
  let imported = 0;
  let duplicates = 0;
  for (const e of postable) {
    if (skip.has(e.hash)) continue;
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
    await postParsedDraft({
      draft: e.draft,
      vendorId: vendor.id,
      currency: vendor.currency,
      defaultTermDays: vendor.creditTermsDays,
      autoConfirmThreshold: settings.autoConfirmThreshold,
      messageId: inserted[0].id,
      source: "import",
      actor: "import",
      occurredAtFallback: e.at,
    });
    imported += 1;
  }
  return ok({ imported, duplicates, vendorId: vendor.id });
}
