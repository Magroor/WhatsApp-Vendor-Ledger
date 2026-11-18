import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaBlobs, waMessages } from "@/db/schema";
import { clientKey, fail, parseId, rateLimit } from "@/lib/api";
import { MAX_MEDIA_BYTES, openWhatsAppMedia } from "@/lib/wa";

export const dynamic = "force-dynamic";

/** Only types that browsers render inertly; anything else is served as a download. */
const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "video/mp4",
]);

/**
 * Streams the original WhatsApp media (bill photo / PDF / voice note) for a
 * stored message, for the audit trail. The Graph API token never leaves the
 * server; nothing is persisted. Meta keeps media for a limited time, after
 * which this returns 410.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!rateLimit(clientKey(req, "media"), 120, 60_000)) return fail("rate-limited", 429);
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (!id) return fail("invalid id", 400);

  const rows = await db
    .select({ mediaId: waMessages.mediaId, mimeType: waMessages.mimeType })
    .from(waMessages)
    .where(eq(waMessages.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return fail("message not found", 404);
  if (!row.mediaId) return fail("no media for this message", 404);

  if (row.mediaId.startsWith("upload:")) {
    const blobId = Number.parseInt(row.mediaId.slice(7), 10);
    const blob = Number.isFinite(blobId)
      ? (await db.select().from(mediaBlobs).where(eq(mediaBlobs.id, blobId)).limit(1))[0]
      : undefined;
    if (!blob) return fail("media unavailable", 410);
    const mime = blob.mimeType.split(";")[0].trim().toLowerCase();
    const safe = INLINE_TYPES.has(mime) ? mime : "application/octet-stream";
    const headers = new Headers({
      "Content-Type": safe,
      "Content-Disposition": safe === mime ? "inline" : `attachment; filename="message-${id}"`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    if (mime.startsWith("image/")) headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return new Response(Buffer.from(blob.dataBase64, "base64"), { status: 200, headers });
  }

  const opened = await openWhatsAppMedia(row.mediaId);
  if (!opened.ok) {
    if (opened.error === "whatsapp-not-configured") return fail("media unavailable (WhatsApp not configured)", 503);
    return fail("media unavailable", opened.retryable ? 502 : 410, { reason: opened.error });
  }

  const declared = Number.parseInt(opened.res.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_MEDIA_BYTES) return fail("media too large", 413);

  const mime = (opened.mimeType ?? row.mimeType ?? "").split(";")[0].trim().toLowerCase();
  const inline = INLINE_TYPES.has(mime);
  const headers = new Headers({
    "Content-Type": inline ? mime : "application/octet-stream",
    "Content-Disposition": inline ? "inline" : `attachment; filename="message-${id}"`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  // Sandbox images; PDF / audio viewers do not work inside a sandboxed document.
  if (mime.startsWith("image/")) headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(opened.res.body, { status: 200, headers });
}
