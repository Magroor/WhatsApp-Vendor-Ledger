import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaBlobs, vendors, waMessages } from "@/db/schema";
import { readChatScreenshot, shotDate, shotMessageHash } from "./chatshot";
import { postParsedDraft } from "./ingest";
import { formatMinor } from "./money";
import { parseLedgerText } from "./parse";
import { getSettings } from "./settings";
import { getUnassignedVendorId, matchVendorByChatTitle } from "./vendormatch";

export type ChatShotOutcome = {
  ok: boolean;
  status: number;
  summary: string;
  added: number;
  duplicates: number;
  vendor?: string;
  needsVendor?: boolean;
};

/**
 * Screenshot of a WhatsApp chat -> one ledger entry per bill/payment message in
 * it. Safe to run on overlapping screenshots: the same image and the same
 * message bubble are only ever posted once.
 */
export async function postChatScreenshot(file: File, vendorIdParam: number | null): Promise<ChatShotOutcome> {
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, status: 503, summary: "Screenshot reading needs GEMINI_API_KEY on the server.", added: 0, duplicates: 0 };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const markerId = `shot-${sha}`;
  const seen = await db.select({ id: waMessages.id }).from(waMessages).where(eq(waMessages.waMessageId, markerId)).limit(1);
  if (seen[0]) return { ok: true, status: 200, summary: "This screenshot was already added.", added: 0, duplicates: 1 };

  const mime = (file.type || "image/jpeg").toLowerCase();
  const read = await readChatScreenshot(bytes.toString("base64"), mime);
  if (!read.shot) {
    return { ok: false, status: 502, summary: `Could not read the screenshot (${read.error ?? "unknown"}). Try again.`, added: 0, duplicates: 0 };
  }
  const { shot } = read;
  if (shot.kind !== "chat" || shot.messages.length === 0) {
    return {
      ok: true,
      status: 200,
      summary: "This doesn't look like a chat screenshot. For a bill photo use Scan bill.",
      added: 0,
      duplicates: 0,
    };
  }

  const settings = await getSettings();
  let vendorId = vendorIdParam;
  if (vendorId) {
    const exists = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!exists[0]) vendorId = null;
  }
  if (!vendorId) vendorId = await matchVendorByChatTitle(shot.chatTitle);
  const unassigned = !vendorId;
  if (!vendorId) vendorId = await getUnassignedVendorId(settings.currency);
  const vendor = (await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1))[0];

  // Keep the screenshot itself for the audit trail; the marker row also makes re-sends a no-op.
  const blob = await db
    .insert(mediaBlobs)
    .values({ mimeType: mime, dataBase64: bytes.toString("base64"), sizeBytes: bytes.length })
    .returning({ id: mediaBlobs.id });
  const mediaRef = `upload:${blob[0].id}`;
  const marker = await db
    .insert(waMessages)
    .values({
      waMessageId: markerId,
      vendorId,
      direction: "in",
      messageType: "image",
      body: null,
      caption: shot.chatTitle,
      mediaId: mediaRef,
      mimeType: mime,
      profileName: vendor.name,
      receivedAt: new Date(),
      parseStatus: "ignored",
      extractionSource: "vision",
    })
    .onConflictDoNothing({ target: waMessages.waMessageId })
    .returning({ id: waMessages.id });
  if (!marker[0]) return { ok: true, status: 200, summary: "This screenshot was already added.", added: 0, duplicates: 1 };
  await db.update(waMessages).set({ mediaUrl: `/api/media/${marker[0].id}` }).where(eq(waMessages.id, marker[0].id));

  const now = new Date();
  let added = 0;
  let duplicates = 0;
  let credit = 0;
  let debit = 0;
  let drafts = 0;
  for (const m of shot.messages) {
    const when = shotDate(m, now) ?? now;
    const draft = parseLedgerText(m.text, {
      currency: vendor.currency,
      now: when,
      defaultTermDays: vendor.creditTermsDays || settings.defaultTermDays,
    });
    if (!draft.entryType || !draft.amountMinor) continue; // chit-chat, not a bill/payment

    const inserted = await db
      .insert(waMessages)
      .values({
        waMessageId: `shotmsg-${shotMessageHash(vendorId, m)}`,
        vendorId,
        direction: "in",
        messageType: "text",
        body: m.text,
        mediaId: mediaRef,
        mimeType: mime,
        profileName: vendor.name,
        receivedAt: when,
        parseStatus: "review",
        parseConfidence: draft.confidence,
        parsePayload: draft as never,
        extractionSource: "vision",
      })
      .onConflictDoNothing({ target: waMessages.waMessageId })
      .returning({ id: waMessages.id });
    if (!inserted[0]) {
      duplicates += 1;
      continue;
    }
    const messageId = inserted[0].id;
    await db.update(waMessages).set({ mediaUrl: `/api/media/${messageId}` }).where(eq(waMessages.id, messageId));
    const tx = await postParsedDraft({
      draft,
      vendorId,
      currency: vendor.currency,
      defaultTermDays: vendor.creditTermsDays || settings.defaultTermDays,
      autoConfirmThreshold: settings.autoConfirmThreshold,
      messageId,
      source: "import",
      actor: "screenshot",
      occurredAtFallback: when,
      status: unassigned ? "draft" : undefined,
    });
    if (tx) {
      added += 1;
      if (tx.status !== "confirmed") drafts += 1;
      if (tx.status === "confirmed") {
        await db.update(waMessages).set({ parseStatus: "parsed" }).where(eq(waMessages.id, messageId));
        if (tx.entryType === "credit") credit += Number(tx.amountMinor);
        else debit += Number(tx.amountMinor);
      }
    }
  }

  const parts: string[] = [];
  if (added) {
    parts.push(`Added ${added} ${added === 1 ? "entry" : "entries"} to ${vendor.name}`);
    const money = [credit ? `credit ${formatMinor(credit, vendor.currency)}` : "", debit ? `debit ${formatMinor(debit, vendor.currency)}` : ""]
      .filter(Boolean)
      .join(", ");
    if (money) parts.push(`(${money})`);
  } else if (duplicates) {
    parts.push("Nothing new: these messages were already added.");
  } else {
    parts.push("No bills or payments found in this screenshot.");
  }
  if (duplicates && added) parts.push(`${duplicates} already added.`);
  if (drafts && !unassigned) parts.push(`${drafts} to check in Inbox (amount shown there).`);
  if (unassigned && added) parts.push("Open Inbox and choose the vendor.");
  return { ok: true, status: 201, summary: parts.join(" "), added, duplicates, vendor: vendor.name, needsVendor: unassigned };
}
