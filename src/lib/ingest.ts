import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  mediaBlobs,
  auditEvents,
  syncQueue,
  transactions,
  txItems,
  vendors,
  waMessages,
} from "@/db/schema";
import {
  buildConfirmationText,
  parseLedgerText,
  type EntryType,
  type ParsedDraft,
} from "./parse";
import { getSettings, logAudit } from "./settings";
import {
  downloadWhatsAppMedia,
  isRetryableHttpStatus,
  matchPhoneCandidates,
  normalizePhone,
  phoneSuffix,
  sendWhatsAppText,
  type WaInboundMessage,
} from "./wa";
import { formatMinor } from "./money";

type AnyRecord = Record<string, unknown>;

/* ------------------------------------------------------------------ vendors */

/**
 * Exact normalized-digit match first; a last-10-digit match (local vs.
 * international format) is accepted only when it is unambiguous.
 */
export async function findVendorByPhone(phone: string | null) {
  const suffix = phoneSuffix(phone);
  if (!suffix) return null;
  const rows = await db
    .select()
    .from(vendors)
    .where(sql`regexp_replace(coalesce(${vendors.phone}, ''), '\\D', '', 'g') like ${"%" + suffix}`)
    .orderBy(vendors.archived, vendors.id)
    .limit(25);
  return matchPhoneCandidates(rows, phone);
}

export async function getOrCreateVendor(input: {
  phone: string | null;
  profileName?: string | null;
  guessName?: string | null;
  currency?: string;
  source?: string;
}): Promise<{ vendor: typeof vendors.$inferSelect; created: boolean }> {
  const existing = await findVendorByPhone(input.phone);
  if (existing) return { vendor: existing, created: false };

  const name =
    input.guessName?.trim() ||
    input.profileName?.trim() ||
    (input.phone ? `Vendor ${normalizePhone(input.phone)}` : "Unknown Vendor");

  const inserted = await db
    .insert(vendors)
    .values({
      name,
      phone: input.phone,
      currency: input.currency ?? "PKR",
      autoCreateSource: input.source ?? "whatsapp",
      needsReview: !input.guessName,
    })
    .returning();
  await logAudit({
    entityType: "vendor",
    entityId: inserted[0].id,
    action: "vendor.auto-created",
    summary: `Auto-created vendor ${name} from WhatsApp contact`,
    payload: { phone: input.phone },
  });
  return { vendor: inserted[0], created: true };
}

/* --------------------------------------------------------------- extraction */

export type ExtractionResult = {
  text: string | null;
  source: "rules" | "vision" | "audio" | "manual" | "none";
  note?: string;
  /** true when a later retry could succeed (network / 429 / 5xx). */
  retryable?: boolean;
};

function hasKey(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 8;
}

export const ANTHROPIC_VISION_MODEL = "claude-haiku-4-5";
export const OPENAI_VISION_MODEL = "gpt-4o-mini";
const OCR_MAX_TOKENS = 2048;
const OCR_SYSTEM =
  "You are a bookkeeping OCR engine for small vendors. Transcribe the bill/receipt exactly as written: items with qty and price, totals, bill number, dates, and any words such as paid/received/credit/udhaar. Output the transcribed text only, no commentary.";
const OCR_USER = "Transcribe this bill.";

const ANTHROPIC_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** "image/JPEG; charset=x" -> "image/jpeg" */
export function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

export function isOcrMime(mime: string | null | undefined): boolean {
  const m = normalizeMime(mime);
  return ANTHROPIC_IMAGE_TYPES.includes(m) || m === "application/pdf";
}

/** Anthropic Messages API body (image or PDF document block, then the instruction). */
export function buildAnthropicVisionRequest(base64: string, mime: string) {
  const m = normalizeMime(mime);
  const mediaBlock =
    m === "application/pdf"
      ? {
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf", data: base64 },
        }
      : {
          type: "image" as const,
          source: { type: "base64" as const, media_type: m, data: base64 },
        };
  return {
    model: ANTHROPIC_VISION_MODEL,
    max_tokens: OCR_MAX_TOKENS,
    system: OCR_SYSTEM,
    messages: [
      { role: "user" as const, content: [mediaBlock, { type: "text" as const, text: OCR_USER }] },
    ],
  };
}

export function readAnthropicText(json: unknown): { text: string | null; note?: string } {
  const root = (json ?? {}) as AnyRecord;
  if (root.stop_reason === "refusal") return { text: null, note: "vision-anthropic-refusal" };
  const content = Array.isArray(root.content) ? (root.content as AnyRecord[]) : [];
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
  if (!text) return { text: null, note: "vision-anthropic-empty" };
  return { text, note: root.stop_reason === "max_tokens" ? "vision-truncated" : undefined };
}

/** OpenAI Chat Completions body, same system prompt / instruction / token cap. */
export function buildOpenAIVisionRequest(base64: string, mime: string) {
  const m = normalizeMime(mime);
  const mediaPart =
    m === "application/pdf"
      ? {
          type: "file" as const,
          file: { filename: "bill.pdf", file_data: `data:application/pdf;base64,${base64}` },
        }
      : {
          type: "image_url" as const,
          image_url: { url: `data:${m};base64,${base64}`, detail: "high" as const },
        };
  return {
    model: OPENAI_VISION_MODEL,
    max_tokens: OCR_MAX_TOKENS,
    messages: [
      { role: "system" as const, content: OCR_SYSTEM },
      { role: "user" as const, content: [mediaPart, { type: "text" as const, text: OCR_USER }] },
    ],
  };
}

export function readOpenAIText(json: unknown): { text: string | null; note?: string } {
  const root = (json ?? {}) as AnyRecord;
  const choices = Array.isArray(root.choices) ? (root.choices as AnyRecord[]) : [];
  const message = (choices[0]?.message ?? {}) as AnyRecord;
  if (typeof message.refusal === "string" && message.refusal) {
    return { text: null, note: "vision-openai-refusal" };
  }
  const text = typeof message.content === "string" ? message.content.trim() : "";
  if (!text) return { text: null, note: "vision-openai-empty" };
  return { text, note: choices[0]?.finish_reason === "length" ? "vision-truncated" : undefined };
}

// Google retires Gemini models regularly (2.5 is already closed to new accounts),
// so try the always-current alias first, then newer/lighter models as fallbacks.
export const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
].filter((m, i, all): m is string => Boolean(m) && all.indexOf(m) === i);

/** Sends one generateContent request, trying fallback models and retrying brief overloads. */
export async function fetchGeminiRaw(requestBody: unknown): Promise<Response> {
  const body = JSON.stringify(requestBody);
  let last: Response | null = null;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const model of GEMINI_MODELS) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": String(process.env.GEMINI_API_KEY) },
        body,
        cache: "no-store",
      });
      if (res.ok) return res;
      last = res;
      // Wrong key / bad request will not improve on another model.
      if (res.status === 400 || res.status === 401 || res.status === 403) return res;
    }
    if (pass === 0) await new Promise((r) => setTimeout(r, 1500)); // brief overload: wait, go round once more
  }
  return last as Response;
}

async function fetchGemini(base64: string, mime: string): Promise<Response> {
  return fetchGeminiRaw(buildGeminiVisionRequest(base64, mime));
}

/** Google Gemini (free tier available): bill photos / PDFs -> transcribed text. */
export function buildGeminiVisionRequest(base64: string, mime: string) {
  return {
    systemInstruction: { parts: [{ text: OCR_SYSTEM }] },
    contents: [
      {
        role: "user",
        parts: [{ inline_data: { mime_type: normalizeMime(mime), data: base64 } }, { text: OCR_USER }],
      },
    ],
    generationConfig: { maxOutputTokens: OCR_MAX_TOKENS, temperature: 0 },
  };
}

export function readGeminiText(json: unknown): { text: string | null; note?: string } {
  const root = (json ?? {}) as AnyRecord;
  const cands = Array.isArray(root.candidates) ? (root.candidates as AnyRecord[]) : [];
  const parts = ((cands[0]?.content as AnyRecord | undefined)?.parts ?? []) as AnyRecord[];
  const text = (Array.isArray(parts) ? parts : [])
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n")
    .trim();
  if (!text) return { text: null, note: "vision-gemini-empty" };
  return { text, note: cands[0]?.finishReason === "MAX_TOKENS" ? "vision-truncated" : undefined };
}

async function callVisionProvider(
  provider: "anthropic" | "openai" | "gemini",
  base64: string,
  mime: string,
): Promise<ExtractionResult> {
  try {
    const res =
      provider === "gemini"
        ? await fetchGemini(base64, mime)
        : provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": String(process.env.ANTHROPIC_API_KEY),
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(buildAnthropicVisionRequest(base64, mime)),
            cache: "no-store",
          })
        : await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify(buildOpenAIVisionRequest(base64, mime)),
            cache: "no-store",
          });
    if (!res.ok) {
      return {
        text: null,
        source: "none",
        note: `vision-${provider}-${res.status}`,
        retryable: isRetryableHttpStatus(res.status),
      };
    }
    const json = await res.json();
    const read =
      provider === "gemini" ? readGeminiText(json) : provider === "anthropic" ? readAnthropicText(json) : readOpenAIText(json);
    return read.text
      ? { text: read.text, source: "vision", note: read.note }
      : { text: null, source: "none", note: read.note };
  } catch (error) {
    return { text: null, source: "none", note: `vision-${provider}: ${(error as Error).message}`, retryable: true };
  }
}

async function visionExtract(base64: string, mimeType: string): Promise<ExtractionResult> {
  const mime = normalizeMime(mimeType) || "image/jpeg";
  if (!isOcrMime(mime)) return { text: null, source: "none", note: `unsupported-media-type:${mime}` };
  // Free provider first, paid ones as fallback.
  const providers: Array<"gemini" | "openai" | "anthropic"> = [];
  if (hasKey("GEMINI_API_KEY")) providers.push("gemini");
  if (hasKey("OPENAI_API_KEY")) providers.push("openai");
  if (hasKey("ANTHROPIC_API_KEY")) providers.push("anthropic");
  if (!providers.length) return { text: null, source: "none", note: "no-vision-key" };
  let last: ExtractionResult = { text: null, source: "none", note: "vision-not-run" };
  for (const provider of providers) {
    last = await callVisionProvider(provider, base64, mime);
    if (last.text) return last;
  }
  return last;
}

async function audioExtract(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  if (!hasKey("OPENAI_API_KEY")) {
    return { text: null, source: "none", note: "no-speech-key" };
  }
  try {
    const mime = normalizeMime(mimeType) || "audio/ogg";
    const ext = mime.includes("mpeg") ? "mp3" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : "ogg";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `voice.${ext}`);
    form.append("model", "whisper-1");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      return { text: null, source: "none", note: `stt-${res.status}`, retryable: isRetryableHttpStatus(res.status) };
    }
    const json = (await res.json()) as AnyRecord;
    return typeof json.text === "string" && json.text.trim()
      ? { text: json.text, source: "audio" }
      : { text: null, source: "none", note: "stt-empty" };
  } catch (error) {
    return { text: null, source: "none", note: (error as Error).message, retryable: true };
  }
}

/** Download media for a stored message and run OCR / transcription. */
async function extractFromMedia(row: {
  messageType: string;
  mediaId: string | null;
  mimeType: string | null;
}): Promise<ExtractionResult | null> {
  const isDoc = row.messageType === "image" || row.messageType === "document";
  const isAudio = row.messageType === "audio";
  if (!isDoc && !isAudio) return null;
  if (!row.mediaId) return { text: null, source: "none", note: "no-media-id" };
  if (row.mediaId.startsWith("upload:")) {
    // Photo uploaded from the app / Share Sheet: bytes live in our own table.
    const blobId = Number.parseInt(row.mediaId.slice(7), 10);
    const blob = Number.isFinite(blobId)
      ? (await db.select().from(mediaBlobs).where(eq(mediaBlobs.id, blobId)).limit(1))[0]
      : undefined;
    if (!blob) return { text: null, source: "none", note: "upload-missing" };
    return isAudio
      ? audioExtract(Buffer.from(blob.dataBase64, "base64"), blob.mimeType)
      : visionExtract(blob.dataBase64, blob.mimeType);
  }
  const media = await downloadWhatsAppMedia(row.mediaId);
  if (!media.bytes) {
    return { text: null, source: "none", note: media.error ?? "media-unavailable", retryable: media.retryable };
  }
  const mime = media.mimeType ?? row.mimeType ?? (isAudio ? "audio/ogg" : "image/jpeg");
  return isAudio ? audioExtract(media.bytes, mime) : visionExtract(media.bytes.toString("base64"), mime);
}

/**
 * Text handed to the parser: body / caption first (it usually carries the
 * credit/debit word), then OCR or transcript. Duplicates are dropped
 * (WhatsApp media messages store the caption in both body and caption).
 */
export function composeSourceText(parts: {
  body?: string | null;
  caption?: string | null;
  ocrText?: string | null;
}): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [parts.body, parts.caption, parts.ocrText]) {
    const t = p?.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ ledger */

export type NewLedgerEntry = {
  vendorId: number;
  entryType: EntryType;
  amountMinor: number;
  currency?: string;
  description?: string | null;
  reference?: string | null;
  paymentMode?: string | null;
  occurredAt?: Date;
  dueDate?: string | null;
  status?: "draft" | "confirmed";
  source?: "whatsapp" | "manual" | "import";
  confidence?: number;
  taxMinor?: number;
  subtotalMinor?: number | null;
  messageId?: number | null;
  items?: ParsedDraft["items"];
  actor?: string;
};

export async function createLedgerEntry(entry: NewLedgerEntry) {
  const inserted = await db
    .insert(transactions)
    .values({
      vendorId: entry.vendorId,
      messageId: entry.messageId ?? null,
      entryType: entry.entryType,
      amountMinor: Math.max(0, Math.round(entry.amountMinor)),
      subtotalMinor: entry.subtotalMinor ?? null,
      taxMinor: entry.taxMinor ?? 0,
      currency: entry.currency ?? "PKR",
      description: entry.description ?? null,
      reference: entry.reference ?? null,
      paymentMode: entry.paymentMode ?? null,
      occurredAt: entry.occurredAt ?? new Date(),
      dueDate: entry.dueDate ?? null,
      status: entry.status ?? "confirmed",
      source: entry.source ?? "whatsapp",
      confidence: entry.confidence ?? 100,
    })
    .returning();

  const tx = inserted[0];
  if (entry.items?.length) {
    await db.insert(txItems).values(
      entry.items.map((item) => ({
        transactionId: tx.id,
        name: item.name,
        sku: item.sku ?? null,
        qty: item.qty,
        unit: item.unit ?? null,
        unitPriceMinor: item.unitPriceMinor ?? null,
        lineTotalMinor: item.lineTotalMinor ?? null,
      })),
    );
  }
  await logAudit({
    entityType: "transaction",
    entityId: tx.id,
    action: "ledger.entry-created",
    actor: entry.actor ?? "automation",
    summary: `${entry.entryType} ${formatMinor(tx.amountMinor, tx.currency)} posted (${tx.source})`,
    payload: { items: entry.items?.length ?? 0, confidence: tx.confidence },
  });
  return tx;
}

export function computeDueDate(occurredAt: Date, termDays: number | null | undefined, fallback: number) {
  const days = termDays ?? fallback;
  const d = new Date(occurredAt.getTime());
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function itemsSubtotal(items: ParsedDraft["items"]): number | null {
  const sum = items.reduce((a, i) => a + (i.lineTotalMinor ?? 0), 0);
  return sum > 0 ? sum : null;
}

/** Convert a parsed draft into a ledger entry against a vendor. Never posts 0 / unknown direction. */
export async function postParsedDraft(params: {
  draft: ParsedDraft;
  vendorId: number;
  currency: string;
  defaultTermDays: number;
  autoConfirmThreshold: number;
  messageId?: number | null;
  source?: "whatsapp" | "manual" | "import";
  actor?: string;
  occurredAtFallback?: Date;
  status?: "draft" | "confirmed";
}) {
  const { draft } = params;
  if (!draft.entryType || draft.amountMinor === null || !(draft.amountMinor > 0)) return null;
  const occurredAt = draft.occurredAtHint ?? params.occurredAtFallback ?? new Date();
  const status: "draft" | "confirmed" =
    params.status ?? (draft.confidence >= params.autoConfirmThreshold ? "confirmed" : "draft");
  return createLedgerEntry({
    vendorId: params.vendorId,
    entryType: draft.entryType,
    amountMinor: draft.amountMinor,
    currency: draft.currency ?? params.currency,
    description: draft.description,
    reference: draft.reference,
    paymentMode: draft.paymentMode,
    occurredAt,
    dueDate:
      draft.entryType === "credit"
        ? computeDueDate(occurredAt, draft.termDays, params.defaultTermDays)
        : null,
    status,
    source: params.source ?? "whatsapp",
    confidence: draft.confidence,
    subtotalMinor: itemsSubtotal(draft.items),
    messageId: params.messageId ?? null,
    items: draft.items,
    actor: params.actor ?? "automation",
  });
}

/** Balance from confirmed entries only (draft and void are excluded). */
export async function vendorBalanceMinor(vendorId: number): Promise<number> {
  const vendorRow = await db
    .select({ opening: vendors.openingBalanceMinor })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  const rows = await db
    .select({
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .where(and(eq(transactions.vendorId, vendorId), eq(transactions.status, "confirmed")));
  const movement = rows.reduce(
    (acc, r) =>
      acc + (r.entryType === "credit" ? Number(r.amountMinor) : -Number(r.amountMinor)),
    0,
  );
  return movement + Number(vendorRow[0]?.opening ?? 0);
}

/** Message parse status implied by its linked ledger entry. */
export function messageStatusForTx(txStatus: string | null | undefined): "parsed" | "review" {
  return txStatus === "confirmed" ? "parsed" : "review";
}

/* ------------------------------------------------------------- ingestion */

export type IngestOutcome = {
  messageId: number;
  vendorId: number | null;
  transactionId: number | null;
  status: "pending" | "parsed" | "review" | "failed" | "duplicate" | "ignored";
  confidence: number;
  note?: string;
  retryable?: boolean;
};

/** Revive a queued WaInboundMessage (jsonb turns Date into string). */
export function reviveInbound(payload: unknown): WaInboundMessage | null {
  const p = (payload ?? {}) as AnyRecord;
  if (typeof p.waMessageId !== "string" || typeof p.from !== "string") return null;
  const received = new Date(String(p.receivedAt ?? ""));
  return {
    ...(p as unknown as WaInboundMessage),
    receivedAt: Number.isNaN(received.getTime()) ? new Date() : received,
  };
}

/**
 * Step 1 (fast, before responding to Meta): persist the raw message.
 * Idempotent on wa_message_id via ON CONFLICT DO NOTHING.
 */
export async function recordInboundMessage(msg: WaInboundMessage): Promise<IngestOutcome> {
  const settings = await getSettings();
  const { vendor, created } = await getOrCreateVendor({
    phone: msg.from,
    profileName: msg.profileName,
    currency: settings.currency,
    source: "whatsapp",
  });

  const inserted = await db
    .insert(waMessages)
    .values({
      waMessageId: msg.waMessageId,
      vendorId: vendor.id,
      direction: "in",
      messageType: msg.messageType,
      body: msg.body,
      caption: msg.caption,
      ocrText: null,
      mediaId: msg.mediaId,
      mediaUrl: null,
      mimeType: msg.mimeType,
      fromPhone: msg.from,
      profileName: msg.profileName,
      receivedAt: msg.receivedAt,
      parseStatus: "pending",
      extractionSource: null,
    })
    .onConflictDoNothing({ target: waMessages.waMessageId })
    .returning({ id: waMessages.id });

  if (!inserted[0]) {
    const existing = await db
      .select({ id: waMessages.id, vendorId: waMessages.vendorId })
      .from(waMessages)
      .where(eq(waMessages.waMessageId, msg.waMessageId))
      .limit(1);
    return {
      messageId: existing[0]?.id ?? 0,
      vendorId: existing[0]?.vendorId ?? null,
      transactionId: null,
      status: "duplicate",
      confidence: 0,
      note: "already-ingested",
    };
  }

  const messageId = inserted[0].id;
  if (msg.mediaId) {
    // Internal, token-free route that streams the bill from WhatsApp on demand.
    await db
      .update(waMessages)
      .set({ mediaUrl: `/api/media/${messageId}` })
      .where(eq(waMessages.id, messageId));
  }
  if (created) {
    await logAudit({
      entityType: "vendor",
      entityId: vendor.id,
      action: "vendor.created-from-message",
      actor: "automation",
      summary: `Vendor ${vendor.name} created from WhatsApp ${msg.from}`,
    });
  }
  return {
    messageId,
    vendorId: vendor.id,
    transactionId: null,
    status: "pending",
    confidence: 0,
  };
}

const STALE_PROCESSING = sql`now() - interval '2 minutes'`;

/**
 * Step 2: extract (media download + OCR / STT), parse and post. Safe to call
 * again: it atomically claims the row and never posts a second entry for the
 * same message. Throws on unexpected errors (row is marked "failed").
 */
export async function processStoredMessage(
  messageId: number,
  opts: { retry?: boolean } = {},
): Promise<IngestOutcome> {
  const claimable = opts.retry
    ? sql`(${waMessages.parseStatus} in ('pending', 'failed', 'review') or (${waMessages.parseStatus} = 'processing' and ${waMessages.createdAt} < ${STALE_PROCESSING}))`
    : sql`${waMessages.parseStatus} in ('pending', 'failed')`;
  const claimed = await db
    .update(waMessages)
    .set({ parseStatus: "processing" })
    .where(and(eq(waMessages.id, messageId), eq(waMessages.direction, "in"), claimable))
    .returning();
  const row = claimed[0];
  if (!row) {
    const current = await db
      .select({ parseStatus: waMessages.parseStatus, vendorId: waMessages.vendorId, conf: waMessages.parseConfidence })
      .from(waMessages)
      .where(eq(waMessages.id, messageId))
      .limit(1);
    return {
      messageId,
      vendorId: current[0]?.vendorId ?? null,
      transactionId: null,
      status: (current[0]?.parseStatus as IngestOutcome["status"]) ?? "failed",
      confidence: current[0]?.conf ?? 0,
      note: current[0] ? "not-claimable" : "message-not-found",
    };
  }

  try {
    const resyncIfPosted = async (): Promise<IngestOutcome | null> => {
      const existingTx = await db
        .select({ id: transactions.id, status: transactions.status })
        .from(transactions)
        .where(eq(transactions.messageId, messageId))
        .limit(1);
      if (!existingTx[0]) return null;
      const status = messageStatusForTx(existingTx[0].status);
      await db.update(waMessages).set({ parseStatus: status }).where(eq(waMessages.id, messageId));
      return {
        messageId,
        vendorId: row.vendorId,
        transactionId: existingTx[0].id,
        status,
        confidence: row.parseConfidence,
        note: "entry-exists",
      };
    };
    // Never double-post: if an entry already exists, just resync the status.
    const early = await resyncIfPosted();
    if (early) return early;

    const settings = await getSettings();
    const vendor =
      (row.vendorId
        ? (await db.select().from(vendors).where(eq(vendors.id, row.vendorId)).limit(1))[0]
        : null) ??
      (await getOrCreateVendor({
        phone: row.fromPhone,
        profileName: row.profileName,
        currency: settings.currency,
      })).vendor;

    let ocrText = row.ocrText;
    let extractionSource = row.extractionSource ?? "rules";
    let extract: ExtractionResult | null = null;
    if (!ocrText) {
      extract = await extractFromMedia(row);
      if (extract?.text) {
        ocrText = extract.text;
        extractionSource = extract.source;
      } else if (extract) {
        extractionSource = "none";
      }
    }

    const sourceText = composeSourceText({ body: row.body, caption: row.caption, ocrText });
    const termDays = vendor.creditTermsDays || settings.defaultTermDays;
    const draft = parseLedgerText(sourceText, {
      currency: vendor.currency,
      now: row.receivedAt,
      defaultTermDays: termDays,
      senderName: row.profileName,
    });
    const retryable = Boolean(extract && !extract.text && extract.retryable);

    if (!sourceText.trim()) {
      await db
        .update(waMessages)
        .set({
          parseStatus: "review",
          parsePayload: draft as never,
          parseConfidence: 0,
          ocrText,
          extractionSource,
          vendorId: vendor.id,
        })
        .where(eq(waMessages.id, messageId));
      await logAudit({
        entityType: "message",
        entityId: messageId,
        action: "message.needs-review",
        actor: "automation",
        summary: `No extractable text (${extract?.note ?? "no text"})`,
      });
      return {
        messageId,
        vendorId: vendor.id,
        transactionId: null,
        status: "review",
        confidence: 0,
        note: extract?.note ?? "no-text",
        retryable,
      };
    }

    // Re-check after the slow extraction (a manual re-parse may have posted meanwhile).
    const late = await resyncIfPosted();
    if (late) return late;

    const tx = await postParsedDraft({
      draft,
      vendorId: vendor.id,
      currency: vendor.currency,
      defaultTermDays: termDays,
      autoConfirmThreshold: settings.autoConfirmThreshold,
      messageId,
      occurredAtFallback: row.receivedAt,
    });
    // Plain chat ("kay hal hain?", "salam bhai") has no amount and no items: keep it
    // in the message log but don't clutter "Needs review". Photos/documents with no
    // amount still go to review because a human should look at the bill.
    const isPlainChat =
      !tx && row.messageType === "text" && draft.amountMinor === null && draft.items.length === 0;
    const status = isPlainChat ? "ignored" : messageStatusForTx(tx?.status);

    await db
      .update(waMessages)
      .set({
        parseStatus: status,
        parseConfidence: draft.confidence,
        parsePayload: draft as never,
        ocrText,
        extractionSource,
        vendorId: vendor.id,
      })
      .where(eq(waMessages.id, messageId));

    await logAudit({
      entityType: "message",
      entityId: messageId,
      action: tx ? "message.auto-posted" : "message.needs-review",
      actor: "automation",
      summary: tx
        ? `Posted ${draft.entryType} ${formatMinor(tx.amountMinor, tx.currency)} as ${tx.status} (confidence ${draft.confidence}%)`
        : `Parsed with confidence ${draft.confidence}% but needs review${extract?.note ? ` (${extract.note})` : ""}`,
      payload: { signals: draft.signals, notes: draft.notes, extraction: extract?.note ?? null },
    });

    let note: string | undefined = extract?.note;
    if (tx && tx.status === "confirmed" && settings.autoReply && row.fromPhone) {
      note = await sendConfirmationReply({
        to: row.fromPhone,
        waMessageId: row.waMessageId,
        vendor,
        tx,
        draft,
        businessName: settings.businessName,
      });
    }

    return {
      messageId,
      vendorId: vendor.id,
      transactionId: tx?.id ?? null,
      status,
      confidence: draft.confidence,
      note,
      // Only worth retrying OCR when nothing was posted from the caption alone.
      retryable: retryable && !tx,
    };
  } catch (error) {
    await db
      .update(waMessages)
      .set({ parseStatus: "failed" })
      .where(eq(waMessages.id, messageId))
      .catch(() => undefined);
    throw error;
  }
}

async function sendConfirmationReply(input: {
  to: string;
  waMessageId: string;
  vendor: typeof vendors.$inferSelect;
  tx: typeof transactions.$inferSelect;
  draft: ParsedDraft;
  businessName: string;
}): Promise<string> {
  const outId = `out-${input.waMessageId}`;
  const reserved = await db
    .insert(waMessages)
    .values({
      waMessageId: outId,
      vendorId: input.vendor.id,
      direction: "out",
      messageType: "text",
      body: null,
      fromPhone: input.to,
      receivedAt: new Date(),
      parseStatus: "ignored",
      extractionSource: "rules",
    })
    .onConflictDoNothing({ target: waMessages.waMessageId })
    .returning({ id: waMessages.id });
  if (!reserved[0]) return "reply-already-sent";

  const balance = await vendorBalanceMinor(input.vendor.id);
  const reply = buildConfirmationText({
    businessName: input.businessName,
    vendorName: input.vendor.name,
    entryType: input.tx.entryType as EntryType,
    amountMinor: input.tx.amountMinor,
    currency: input.tx.currency,
    reference: input.tx.reference,
    balanceMinor: balance,
    items: input.draft.items,
  });
  await db.update(waMessages).set({ body: reply }).where(eq(waMessages.id, reserved[0].id));
  const sent = await sendWhatsAppText(input.to, reply);
  if (!sent.sent) {
    await db.insert(syncQueue).values({
      kind: "send",
      payload: { to: input.to, body: reply } as never,
      status: "pending",
      lastError: sent.error ?? "simulated",
    });
    return "reply-queued";
  }
  return "reply-sent";
}

/** Queue a message for re-ingestion by /api/sync (one pending job per message). */
export async function enqueueIngestRetry(messageId: number, error: string | undefined) {
  const lastError = (error ?? "retry").slice(0, 500);
  const existing = await db
    .select({ id: syncQueue.id })
    .from(syncQueue)
    .where(
      and(
        eq(syncQueue.kind, "ingest"),
        eq(syncQueue.status, "pending"),
        sql`${syncQueue.payload}->>'messageId' = ${String(messageId)}`,
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db.update(syncQueue).set({ lastError }).where(eq(syncQueue.id, existing[0].id));
    return;
  }
  await db.insert(syncQueue).values({
    kind: "ingest",
    payload: { messageId } as never,
    status: "pending",
    lastError,
  });
}

/** processStoredMessage + queue on failure / transient extraction error. Never throws. */
export async function processStoredMessageSafe(messageId: number): Promise<IngestOutcome> {
  try {
    const outcome = await processStoredMessage(messageId);
    if (outcome.retryable) await enqueueIngestRetry(messageId, outcome.note);
    return outcome;
  } catch (error) {
    const message = (error as Error).message;
    await enqueueIngestRetry(messageId, message).catch(() => undefined);
    return {
      messageId,
      vendorId: null,
      transactionId: null,
      status: "failed",
      confidence: 0,
      note: message,
      retryable: true,
    };
  }
}

/** Record + process synchronously (manual capture endpoint). */
export async function ingestInboundMessage(msg: WaInboundMessage): Promise<IngestOutcome> {
  const recorded = await recordInboundMessage(msg);
  if (recorded.status === "duplicate") return recorded;
  return processStoredMessageSafe(recorded.messageId);
}

/* ------------------------------------------------------------- reparse */

export type ReparseOverride = { entryType?: EntryType; amountMinor?: number; vendorId?: number };

export type ReparsePlan =
  | { post: false; reason: "missing-entry-type" | "missing-amount" }
  | {
      post: true;
      entryType: EntryType;
      amountMinor: number;
      status: "draft" | "confirmed" | "void";
      reviewerConfirmed: boolean;
    };

/**
 * Decide what a re-parse may write. Incomplete drafts never post (no guessed
 * direction, no 0 amount). A reviewer supplying both direction and amount
 * confirms the entry; otherwise the confidence threshold decides. Void stays void.
 */
export function planReparse(input: {
  draft: Pick<ParsedDraft, "entryType" | "amountMinor" | "confidence">;
  override?: ReparseOverride;
  autoConfirmThreshold: number;
  existingStatus?: string | null;
}): ReparsePlan {
  const entryType = input.override?.entryType ?? input.draft.entryType;
  const amountMinor =
    typeof input.override?.amountMinor === "number" ? input.override.amountMinor : input.draft.amountMinor;
  if (!entryType) return { post: false, reason: "missing-entry-type" };
  if (amountMinor === null || !Number.isFinite(amountMinor) || Math.round(amountMinor) <= 0) {
    return { post: false, reason: "missing-amount" };
  }
  const reviewerConfirmed =
    Boolean(input.override?.entryType) && typeof input.override?.amountMinor === "number";
  const status =
    input.existingStatus === "void"
      ? "void"
      : reviewerConfirmed ||
          input.existingStatus === "confirmed" ||
          input.draft.confidence >= input.autoConfirmThreshold
        ? "confirmed"
        : "draft";
  return { post: true, entryType, amountMinor: Math.round(amountMinor), status, reviewerConfirmed };
}

/** Re-run extraction for an existing message (retry / manual reparse). */
export async function reparseMessage(messageId: number, override?: ReparseOverride) {
  const rows = await db.select().from(waMessages).where(eq(waMessages.id, messageId)).limit(1);
  const message = rows[0];
  if (!message) return null;

  const settings = await getSettings();
  let vendor: typeof vendors.$inferSelect | null = null;
  if (override?.vendorId) {
    vendor = (await db.select().from(vendors).where(eq(vendors.id, override.vendorId)).limit(1))[0] ?? null;
    if (!vendor) throw new Error("vendor-not-found");
  } else if (message.vendorId) {
    vendor = (await db.select().from(vendors).where(eq(vendors.id, message.vendorId)).limit(1))[0] ?? null;
  }
  if (!vendor) {
    vendor = (
      await getOrCreateVendor({
        phone: message.fromPhone,
        profileName: message.profileName,
        currency: settings.currency,
      })
    ).vendor;
  }

  // Media whose OCR failed earlier gets another extraction attempt.
  let ocrText = message.ocrText;
  let extractionSource = message.extractionSource;
  if (!ocrText) {
    const extract = await extractFromMedia(message);
    if (extract?.text) {
      ocrText = extract.text;
      extractionSource = extract.source;
    }
  }

  const termDays = vendor.creditTermsDays || settings.defaultTermDays;
  const sourceText = composeSourceText({ body: message.body, caption: message.caption, ocrText });
  const draft = parseLedgerText(sourceText, {
    currency: vendor.currency,
    now: message.receivedAt,
    defaultTermDays: termDays,
    senderName: message.profileName,
  });

  const existingTx = (
    await db
      .select({ id: transactions.id, status: transactions.status, occurredAt: transactions.occurredAt })
      .from(transactions)
      .where(eq(transactions.messageId, messageId))
      .limit(1)
  )[0];

  const plan = planReparse({
    draft,
    override,
    autoConfirmThreshold: settings.autoConfirmThreshold,
    existingStatus: existingTx?.status ?? null,
  });
  const effective: ParsedDraft = plan.post
    ? { ...draft, entryType: plan.entryType, amountMinor: plan.amountMinor }
    : draft;

  let txId: number | null = existingTx?.id ?? null;
  let txStatus: string | null = existingTx?.status ?? null;
  const vendorId = vendor.id;
  const vendorCurrency = vendor.currency;

  if (plan.post && existingTx) {
    const occurredAt = effective.occurredAtHint ?? existingTx.occurredAt;
    const id = existingTx.id;
    await db.transaction(async (trx) => {
      await trx
        .update(transactions)
        .set({
          vendorId,
          entryType: plan.entryType,
          amountMinor: plan.amountMinor,
          currency: effective.currency ?? vendorCurrency,
          description: effective.description,
          reference: effective.reference,
          paymentMode: effective.paymentMode,
          subtotalMinor: itemsSubtotal(effective.items),
          occurredAt,
          dueDate:
            plan.entryType === "credit" ? computeDueDate(occurredAt, effective.termDays, termDays) : null,
          status: plan.status,
          confidence: plan.reviewerConfirmed ? 100 : effective.confidence,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, id));
      await trx.delete(txItems).where(eq(txItems.transactionId, id));
      if (effective.items.length) {
        await trx.insert(txItems).values(
          effective.items.map((i) => ({
            transactionId: id,
            name: i.name,
            sku: i.sku ?? null,
            qty: i.qty,
            unit: i.unit ?? null,
            unitPriceMinor: i.unitPriceMinor ?? null,
            lineTotalMinor: i.lineTotalMinor ?? null,
          })),
        );
      }
    });
    txStatus = plan.status;
  } else if (!plan.post && existingTx && override?.vendorId) {
    // Draft incomplete: leave amounts alone, but honour an explicit vendor reassignment.
    await db
      .update(transactions)
      .set({ vendorId: vendor.id, currency: vendor.currency, updatedAt: new Date() })
      .where(eq(transactions.id, existingTx.id));
  } else if (plan.post && !existingTx) {
    const tx = await postParsedDraft({
      draft: effective,
      vendorId: vendor.id,
      currency: vendor.currency,
      defaultTermDays: termDays,
      autoConfirmThreshold: settings.autoConfirmThreshold,
      messageId,
      actor: "reviewer",
      occurredAtFallback: message.receivedAt,
      status: plan.status === "void" ? "draft" : plan.status,
    });
    txId = tx?.id ?? null;
    txStatus = tx?.status ?? null;
  }

  await db
    .update(waMessages)
    .set({
      parseStatus: messageStatusForTx(txStatus),
      parseConfidence: plan.post && plan.reviewerConfirmed ? 100 : draft.confidence,
      parsePayload: effective as never,
      ocrText,
      extractionSource,
      vendorId: vendor.id,
    })
    .where(eq(waMessages.id, messageId));

  await logAudit({
    entityType: "message",
    entityId: messageId,
    action: "message.reparsed",
    actor: "reviewer",
    summary: plan.post
      ? `Re-parsed message ${messageId}: ${plan.entryType} ${formatMinor(plan.amountMinor, vendor.currency)} (${txStatus ?? "not posted"})`
      : `Re-parsed message ${messageId}: incomplete (${plan.reason}), left for review`,
    payload: { override: override ?? null, transactionId: txId, vendorId: vendor.id },
  });

  return { transactionId: txId, draft: effective, posted: plan.post, reason: plan.post ? undefined : plan.reason };
}

export async function setTransactionStatus(id: number, status: "draft" | "confirmed" | "void") {
  const updated = await db
    .update(transactions)
    .set({ status, updatedAt: new Date() })
    .where(eq(transactions.id, id))
    .returning();
  await logAudit({
    entityType: "transaction",
    entityId: id,
    action: `ledger.${status}`,
    actor: "reviewer",
    summary: `Entry ${id} set to ${status}`,
  });
  return updated[0] ?? null;
}

export async function dashboardStats() {
  const vendorRowsQ = db
    .select({
      id: vendors.id,
      name: vendors.name,
      phone: vendors.phone,
      currency: vendors.currency,
      creditTermsDays: vendors.creditTermsDays,
      opening: vendors.openingBalanceMinor,
      businessType: vendors.businessType,
      city: vendors.city,
      needsReview: vendors.needsReview,
    })
    .from(vendors)
    .where(eq(vendors.archived, false));

  const activityRowsQ = db
    .select({
      vendorId: transactions.vendorId,
      last: sql<string>`max(${transactions.occurredAt})`,
    })
    .from(transactions)
    .where(eq(transactions.status, "confirmed"))
    .groupBy(transactions.vendorId);

  const totalsQ = db
    .select({
      vendorId: transactions.vendorId,
      entryType: transactions.entryType,
      total: sql<string>`sum(${transactions.amountMinor})`,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(eq(transactions.status, "confirmed"))
    .groupBy(transactions.vendorId, transactions.entryType);

  const pendingMessagesQ = db
    .select({ count: sql<number>`count(*)::int` })
    .from(waMessages)
    .where(inArray(waMessages.parseStatus, ["pending", "processing", "review"]));

  const lastMessageQ = db
    .select({ receivedAt: waMessages.receivedAt, profileName: waMessages.profileName })
    .from(waMessages)
    .orderBy(desc(waMessages.receivedAt))
    .limit(1);

  const auditCountQ = db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents);

  // One round trip's worth of latency instead of six: the queries are independent.
  const [vendorRows, activityRows, totals, pendingMessages, lastMessage, auditCount] = await Promise.all([
    vendorRowsQ,
    activityRowsQ,
    totalsQ,
    pendingMessagesQ,
    lastMessageQ,
    auditCountQ,
  ]);

  const map = new Map<number, { credit: number; debit: number; count: number }>();
  for (const row of totals) {
    const entry = map.get(row.vendorId) ?? { credit: 0, debit: 0, count: 0 };
    if (row.entryType === "credit") entry.credit += Number(row.total);
    else entry.debit += Number(row.total);
    entry.count += row.count;
    map.set(row.vendorId, entry);
  }

  return {
    vendors: vendorRows.map((v) => {
      const t = map.get(v.id) ?? { credit: 0, debit: 0, count: 0 };
      const activity = activityRows.find((a) => a.vendorId === v.id);
      return {
        id: v.id,
        name: v.name,
        phone: v.phone,
        currency: v.currency,
        creditTermsDays: v.creditTermsDays,
        businessType: v.businessType,
        city: v.city,
        needsReview: v.needsReview,
        lastActivity: activity?.last ? new Date(activity.last) : null,
        creditMinor: t.credit,
        debitMinor: t.debit,
        count: t.count,
        balanceMinor: t.credit - t.debit + Number(v.opening),
      };
    }),
    pendingMessages: pendingMessages[0]?.count ?? 0,
    lastMessageAt: lastMessage[0]?.receivedAt ?? null,
    auditCount: auditCount[0]?.count ?? 0,
  };
}
