import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaBlobs, transactions, vendors, waMessages } from "@/db/schema";
import { clientKey, fail, ok, parseId, rateLimit } from "@/lib/api";
import { processStoredMessageSafe, setTransactionStatus } from "@/lib/ingest";
import { formatMinor } from "@/lib/money";
import { captureAuthorized } from "@/lib/session";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_BYTES = 4_000_000; // Vercel request bodies are capped at ~4.5 MB
const MAX_FILES = 4;
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
const UNASSIGNED = "Unassigned (choose vendor)";

/** Pick an existing vendor whose name appears in the shared text. */
async function matchVendorByText(text: string): Promise<number | null> {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(eq(vendors.archived, false));
  const full = rows.filter((v) => v.name.length >= 3 && t.includes(v.name.toLowerCase()));
  if (full.length === 1) return full[0].id;
  const byToken = rows.filter((v) => {
    const first = (v.name.toLowerCase().split(/\s+/)[0] ?? "").replace(/[^a-z0-9]/g, "");
    return first.length >= 4 && new RegExp(`\\b${first}\\b`).test(t);
  });
  return byToken.length === 1 ? byToken[0].id : null;
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
  const files: File[] = [];
  const ctype = req.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      text = String(form.get("text") ?? "");
      vendorIdRaw = form.get("vendorId") ? String(form.get("vendorId")) : null;
      for (const key of ["image", "file", "images"]) {
        for (const v of form.getAll(key)) if (typeof v !== "string") files.push(v);
      }
    } else {
      const json = (await req.json()) as { text?: string; vendorId?: number | string };
      text = String(json.text ?? "");
      vendorIdRaw = json.vendorId ? String(json.vendorId) : null;
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

  const settings = await getSettings();
  let vendorId = parseId(vendorIdRaw);
  if (vendorId) {
    const exists = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!exists[0]) vendorId = null;
  }
  if (!vendorId) vendorId = await matchVendorByText(text);
  let unassigned = false;
  if (!vendorId) {
    const found = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.name, UNASSIGNED)).limit(1);
    if (found[0]) vendorId = found[0].id;
    else {
      const created = await db
        .insert(vendors)
        .values({ name: UNASSIGNED, currency: settings.currency, autoCreateSource: "capture", needsReview: true })
        .returning({ id: vendors.id });
      vendorId = created[0].id;
    }
    unassigned = true;
  }
  const vendorRow = (await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1))[0];

  const jobs: Array<{ file: File | null }> = files.length ? files.map((file) => ({ file })) : [{ file: null }];
  const results: Array<Record<string, unknown>> = [];

  for (const { file } of jobs) {
    let mediaId: string | null = null;
    let mime: string | null = null;
    if (file) {
      const bytes = Buffer.from(await file.arrayBuffer());
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
        waMessageId: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
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
    results.push({
      messageId,
      status: msgUnassigned && tx ? "review" : tx && tx.status !== "confirmed" ? "review" : outcome.status,
      entryType: tx?.entryType ?? null,
      amount: tx ? formatMinor(Number(tx.amountMinor), tx.currency) : null,
      vendor: msgVendor.name,
      needsVendor: msgUnassigned,
    });
  }

  const first = results[0];
  const needsVendor = results.some((r) => r.needsVendor);
  const summary = first.amount
    ? first.needsVendor
      ? `Read ${first.amount} (${first.entryType}). Open Inbox and choose the vendor.`
      : first.status === "review"
        ? `Read ${first.amount} (${first.entryType}) for ${first.vendor}. Please confirm it in Inbox.`
        : `Added ${first.entryType} ${first.amount} to ${first.vendor}.`
    : "Saved, but no amount was found. Open Inbox, Needs review.";
  return ok({ summary, results, needsVendor }, 201);
}
