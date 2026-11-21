import crypto from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { mediaBlobs, transactions, vendors, waMessages } from "@/db/schema";
import { clientKey, fail, ok, parseId, rateLimit } from "@/lib/api";
import { findVendorByPhone, processStoredMessageSafe, setTransactionStatus } from "@/lib/ingest";
import { formatMinor } from "@/lib/money";
import { captureAuthorized } from "@/lib/session";
import { getSettings } from "@/lib/settings";
import { findLikelyDuplicate } from "@/lib/duplicates";
import { postChatScreenshot } from "@/lib/chatshot-post";
import { getUnassignedVendorId, matchVendorByText } from "@/lib/vendormatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 4_000_000; // Vercel request bodies are capped at ~4.5 MB
const MAX_FILES = 4;
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
/** Vendor phone numbers, so the PC bridge only forwards chats with known vendors. */
export async function GET(req: Request) {
  if (!(await captureAuthorized(req))) return fail("unauthorized", 401);
  const rows = await db
    .select({ id: vendors.id, name: vendors.name, phone: vendors.phone })
    .from(vendors)
    .where(eq(vendors.archived, false));
  return ok({ vendors: rows.filter((v) => v.phone) });
}

/**
 * One-step capture for the app's "Scan bill" button and the iPhone Share Sheet
 * Shortcut. multipart/form-data fields: text, vendorId (optional), image (0..4
 * files). JSON {text, vendorId} also works. Reads the bill and posts the entry.
 */
export async function POST(req: Request) {
  if (!(await captureAuthorized(req))) return fail("unauthorized", 401);
  if (!rateLimit(clientKey(req, "capture-upload"), 40, 60_000)) return fail("rate-limited", 429);

  let text = "";
  let vendorIdRaw: string | null = null;
  let phone: string | null = null;
  let externalId: string | null = null;
  let kind: string | null = null;
  const files: File[] = [];
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      text = String(form.get("text") ?? "");
      vendorIdRaw = form.get("vendorId") ? String(form.get("vendorId")) : null;
      phone = form.get("phone") ? String(form.get("phone")) : null;
      externalId = form.get("externalId") ? String(form.get("externalId")) : null;
      kind = form.get("kind") ? String(form.get("kind")) : null;
      for (const key of ["image", "file", "images"]) {
        for (const v of form.getAll(key)) if (typeof v !== "string") files.push(v);
      }
    } else {
      const json = (await req.json()) as {
        text?: string;
        vendorId?: number | string;
        phone?: string;
        externalId?: string;
      };
      text = String(json.text ?? "");
      vendorIdRaw = json.vendorId ? String(json.vendorId) : null;
      phone = json.phone ? String(json.phone) : null;
      externalId = json.externalId ? String(json.externalId) : null;
    }
  } catch {
    return fail("Could not read the upload.");
  }
  text = text.trim().slice(0, 6000);
  if (!text && files.length === 0) return fail("Nothing to add: share some text or a photo.");
  if (files.length > MAX_FILES) return fail(`Please share at most ${MAX_FILES} photos at a time.`);
  for (const f of files) {
    if (!OK_MIME.has((f.type || "").toLowerCase())) return fail("Only photos (JPEG/PNG/HEIC) and PDFs are supported.");
    if (f.size > MAX_IMAGE_BYTES) return fail("Photo is too large (max 4 MB). Use a smaller picture.", 413);
  }

  // Screenshot of a whole chat: read every message in it (see lib/chatshot-post).
  if (kind === "chat") {
    if (!files.length) return fail("Attach a screenshot of the chat.");
    const out = await postChatScreenshot(files[0], parseId(vendorIdRaw));
    if (!out.ok) return fail(out.summary, out.status);
    return ok({ summary: out.summary, added: out.added, duplicates: out.duplicates, vendor: out.vendor, needsVendor: out.needsVendor, transactionIds: out.transactionIds }, out.status);
  }

  // Bridge messages carry a stable id: never process the same WhatsApp message twice.
  const waId = externalId ? `bridge-${externalId.slice(0, 120)}` : null;
  if (waId) {
    const seen = await db.select({ id: waMessages.id }).from(waMessages).where(eq(waMessages.waMessageId, waId)).limit(1);
    if (seen[0]) return ok({ summary: "Already added.", duplicate: true, results: [] });
  }

  const settings = await getSettings();
  let vendorId = parseId(vendorIdRaw);
  if (!vendorId && phone) {
    const byPhone = await findVendorByPhone(phone);
    if (byPhone) vendorId = byPhone.id;
    else if (waId) return ok({ summary: "Skipped: not a saved vendor.", skipped: true, results: [] });
  }
  if (vendorId) {
    const exists = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!exists[0]) vendorId = null;
  }
  if (!vendorId) vendorId = await matchVendorByText(text);
  let unassigned = false;
  if (!vendorId) {
    vendorId = await getUnassignedVendorId(settings.currency);
    unassigned = true;
  }
  const vendorRow = (await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1))[0];

  const jobs: Array<{ file: File | null }> = files.length ? files.map((file) => ({ file })) : [{ file: null }];
  const results: Array<Record<string, unknown>> = [];

  for (const { file } of jobs) {
    let mediaId: string | null = null;
    let mime: string | null = null;
    let imageKey: string | null = null;
    if (file) {
      const bytes = Buffer.from(await file.arrayBuffer());
      // The same picture is never added twice (an automation may re-send it).
      const key = `img-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
      const prior = (await db
        .select({ id: waMessages.id })
        .from(waMessages)
        .where(eq(waMessages.waMessageId, key))
        .limit(1))[0];
      // Only a picture that already produced an entry is a duplicate; an earlier attempt that
      // failed, timed out or found no amount must stay retryable.
      const priorEntry = prior
        ? (await db
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(eq(transactions.messageId, prior.id), ne(transactions.status, "void")))
            .limit(1))[0]
        : undefined;
      if (priorEntry) {
        results.push({ status: "duplicate", amount: null, entryType: null, vendor: vendorRow.name, needsVendor: false, duplicate: true });
        continue;
      }
      if (!prior) imageKey = key;
      mime = (file.type || "image/jpeg").toLowerCase();
      const blob = await db
        .insert(mediaBlobs)
        .values({ mimeType: mime, dataBase64: bytes.toString("base64"), sizeBytes: bytes.length })
        .returning({ id: mediaBlobs.id });
      mediaId = `upload:${blob[0].id}`;
    }
    const inserted = await db
      .insert(waMessages)
      .values({
        waMessageId: waId ?? imageKey ?? `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        vendorId,
        direction: "in",
        messageType: file ? (mime === "application/pdf" ? "document" : "image") : "text",
        body: text || null,
        caption: file ? text || null : null,
        mediaId,
        mimeType: mime,
        fromPhone: null, // never auto-reply to the vendor for uploads
        profileName: vendorRow.name,
        receivedAt: new Date(),
        parseStatus: "pending",
      })
      .returning({ id: waMessages.id });
    const messageId = inserted[0].id;
    if (mediaId) {
      await db.update(waMessages).set({ mediaUrl: `/api/media/${messageId}` }).where(eq(waMessages.id, messageId));
    }

    const outcome = await processStoredMessageSafe(messageId);
    let tx = (await db.select().from(transactions).where(eq(transactions.messageId, messageId)).limit(1))[0];
    let msgVendor = vendorRow;
    let msgUnassigned = unassigned;

    // The vendor's name is often printed on the bill: try the text read from the photo.
    if (unassigned) {
      const msg = (await db.select({ ocr: waMessages.ocrText }).from(waMessages).where(eq(waMessages.id, messageId)).limit(1))[0];
      const found = await matchVendorByText(msg?.ocr ?? "");
      if (found) {
        msgVendor = (await db.select().from(vendors).where(eq(vendors.id, found)).limit(1))[0];
        await db.update(waMessages).set({ vendorId: found }).where(eq(waMessages.id, messageId));
        if (tx) {
          await db.update(transactions).set({ vendorId: found }).where(eq(transactions.id, tx.id));
          if (tx.confidence >= settings.autoConfirmThreshold) {
            await setTransactionStatus(tx.id, "confirmed");
            await db.update(waMessages).set({ parseStatus: "parsed" }).where(eq(waMessages.id, messageId));
          }
          tx = (await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1))[0];
        }
        msgUnassigned = false;
      }
    }
    if (tx && msgUnassigned && tx.status === "confirmed") {
      // Keep unassigned entries out of totals until a vendor is chosen.
      await setTransactionStatus(tx.id, "draft");
      await db.update(waMessages).set({ parseStatus: "review" }).where(eq(waMessages.id, messageId));
    }
    const payload = (await db.select({ p: waMessages.parsePayload }).from(waMessages).where(eq(waMessages.id, messageId)).limit(1))[0]?.p as
      | { notes?: string[] }
      | null
      | undefined;
    const dup =
      tx && !msgUnassigned
        ? await findLikelyDuplicate({ id: tx.id, vendorId: tx.vendorId, entryType: tx.entryType, amountMinor: Number(tx.amountMinor), occurredAt: tx.occurredAt })
        : null;
    results.push({
      messageId,
      possibleDuplicate: dup ? { transactionId: dup.id, date: dup.occurredAt.toISOString() } : null,
      vendorId: msgVendor.id,
      transactionId: tx?.id ?? null,
      amountMinor: tx ? Number(tx.amountMinor) : null,
      assumedDirection: Boolean(payload?.notes?.includes("direction-assumed-credit")),
      status: msgUnassigned && tx ? "review" : tx && tx.status !== "confirmed" ? "review" : outcome.status,
      entryType: tx?.entryType ?? null,
      amount: tx ? formatMinor(Number(tx.amountMinor), tx.currency) : null,
      vendor: msgVendor.name,
      needsVendor: msgUnassigned,
    });
  }

  if (results.every((r) => r.duplicate)) return ok({ summary: "Already added.", duplicate: true, results, needsVendor: false });
  // Push "N bills to check" after the response (best-effort; debounced in lib/push).
  if (results.some((r) => r.status === "review")) {
    try {
      const { after } = await import("next/server");
      after(() => import("@/lib/push").then((m) => m.notifyReviewNeeded()).then(() => undefined, () => undefined));
    } catch {
      /* notifications are best-effort */
    }
  }
  const first = results.find((r) => !r.duplicate) ?? results[0];
  const needsVendor = results.some((r) => r.needsVendor);
  const summary = first.amount
    ? first.needsVendor
      ? `Read ${first.amount} (${first.entryType}). Open Inbox and choose the vendor.`
      : first.status === "review"
        ? `Read ${first.amount} (${first.entryType}) for ${first.vendor}. Please confirm it in Inbox.`
        : `Added ${first.entryType} ${first.amount} to ${first.vendor}.`
    : first.status === "ignored"
      ? "Chat message, nothing to add."
      : "Saved, but no amount was found. Open Inbox, Needs review.";
  return ok({ summary, results, needsVendor }, 201);
}
