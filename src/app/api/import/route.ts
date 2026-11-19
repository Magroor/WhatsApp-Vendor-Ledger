import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors, waMessages } from "@/db/schema";
import { clientKey, fail, ok, rateLimit, readJson } from "@/lib/api";
import { draftsFromChat, parseChatExport } from "@/lib/chatimport";
import { postChatImport } from "@/lib/chatimport-post";
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

  const created = await postChatImport({
    text,
    vendorId: body.vendorId ?? null,
    vendorName: body.newVendorName?.trim() || null,
    vendorPhone: body.newVendorPhone ?? null,
    skip: new Set(body.skip ?? []),
    dayFirst: body.dayFirst,
  });
  if ("error" in created) return fail(created.error);
  return ok({ imported: created.imported, duplicates: created.duplicates, vendorId: created.vendorId });
}
