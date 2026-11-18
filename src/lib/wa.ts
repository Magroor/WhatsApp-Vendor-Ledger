import crypto from "node:crypto";

/**
 * WhatsApp Business Cloud API client.
 * Secrets are only ever read from process.env on the server — never logged,
 * never returned to the client.
 */

export type WaInboundMessage = {
  waMessageId: string;
  from: string;
  profileName: string | null;
  receivedAt: Date;
  messageType: "text" | "image" | "audio" | "document" | "video" | "sticker" | "system" | "unknown";
  body: string | null;
  caption: string | null;
  mediaId: string | null;
  mimeType: string | null;
  phoneNumberId: string | null;
};

export type NormalizedWebhook = {
  contacts: Array<{ waId: string; profileName: string | null }>;
  messages: WaInboundMessage[];
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Normalize a WhatsApp Cloud API webhook body into flat inbound messages. */
export function normalizeWebhook(payload: unknown): NormalizedWebhook {
  const root = asRecord(payload);
  const result: NormalizedWebhook = { contacts: [], messages: [] };
  if (!root) return result;

  for (const entryRaw of asArray(root.entry)) {
    const entry = asRecord(entryRaw);
    for (const changeRaw of asArray(entry?.changes)) {
      const change = asRecord(changeRaw);
      const value = asRecord(change?.value);
      if (!value) continue;

      const metadata = asRecord(value.metadata);
      const phoneNumberId = metadata ? str(metadata.phone_number_id) : null;

      for (const cRaw of asArray(value.contacts)) {
        const c = asRecord(cRaw);
        if (!c) continue;
        const profile = asRecord(c.profile);
        result.contacts.push({
          waId: str(c.wa_id) ?? "",
          profileName: profile ? str(profile.name) : null,
        });
      }

      for (const mRaw of asArray(value.messages)) {
        const m = asRecord(mRaw);
        if (!m) continue;
        const id =
          str(m.id) ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const from = str(m.from) ?? "";
        const type = (str(m.type) ?? "unknown").toLowerCase();
        const tsSeconds = Number.parseInt(str(m.timestamp) ?? "0", 10);
        const receivedAt =
          Number.isFinite(tsSeconds) && tsSeconds > 0
            ? new Date(tsSeconds * 1000)
            : new Date();

        let body: string | null = null;
        let caption: string | null = null;
        let mediaId: string | null = null;
        let mimeType: string | null = null;
        let messageType: WaInboundMessage["messageType"] = "unknown";

        if (type === "text") {
          const textObj = asRecord(m.text);
          body = textObj ? str(textObj.body) : null;
          messageType = "text";
        } else if (
          type === "image" ||
          type === "document" ||
          type === "video" ||
          type === "sticker"
        ) {
          const media = asRecord(m.image) ?? asRecord(m.document) ?? asRecord(m.video) ?? asRecord(m.sticker);
          caption = media ? str(media.caption) : null;
          mediaId = media ? str(media.id) : null;
          mimeType = media ? str(media.mime_type) : null;
          body = caption;
          messageType = type === "document" ? "document" : type;
        } else if (type === "audio" || type === "voice") {
          const media = asRecord(m.audio) ?? asRecord(m.voice);
          mediaId = media ? str(media.id) : null;
          mimeType = media ? str(media.mime_type) : null;
          messageType = "audio";
        } else if (type === "button" || type === "interactive") {
          const button = asRecord(m.button);
          body = button ? str(button.text) : JSON.stringify(m).slice(0, 500);
          messageType = "text";
        } else if (type === "system") {
          const system = asRecord(m.system);
          body = system ? str(system.body) : null;
          messageType = "system";
        }

        result.messages.push({
          waMessageId: id,
          from,
          profileName:
            result.contacts.find((c) => c.waId === from)?.profileName ?? null,
          receivedAt,
          messageType,
          body,
          caption,
          mediaId,
          mimeType,
          phoneNumberId,
        });
      }
    }
  }
  return result;
}

/**
 * X-Hub-Signature-256 verification (SHA256 HMAC over the raw body).
 * Fails closed in production when no app secret is configured; in development
 * an unsigned webhook is allowed but the reason says so.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): { ok: boolean; reason?: string } {
  if (!appSecret) {
    if (nodeEnv === "production") return { ok: false, reason: "no-secret-configured" };
    return { ok: true, reason: "dev-mode-unverified-no-secret" };
  }
  if (!signatureHeader?.startsWith("sha256=")) {
    return { ok: false, reason: "missing-signature" };
  }
  const provided = signatureHeader.slice(7).trim().toLowerCase();
  // Buffer.from(…, "hex") silently drops invalid chars, so validate first.
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: "malformed-signature" };
  }
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest();
  const b = Buffer.from(provided, "hex");
  if (expected.length !== b.length || !crypto.timingSafeEqual(expected, b)) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true };
}

/**
 * Full normalized digits (international "00" prefix stripped). Never truncated:
 * truncation is only used as an unambiguous fallback in matchPhoneCandidates.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits || null;
}

/** Last N digits, used only as a fallback key for local vs. international formats. */
export function phoneSuffix(phone: string | null | undefined, n = 10): string | null {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  return digits.length > n ? digits.slice(-n) : digits;
}

/**
 * Pick the vendor whose phone matches. Exact normalized-digit match wins; the
 * last-10-digit fallback (e.g. 0300… vs 92300…) is used only when both numbers
 * have at least 10 digits and exactly one candidate matches.
 */
export function matchPhoneCandidates<T extends { phone: string | null }>(
  candidates: T[],
  phone: string | null | undefined,
): T | null {
  const target = normalizePhone(phone);
  if (!target) return null;
  const exact = candidates.filter((c) => normalizePhone(c.phone) === target);
  if (exact.length >= 1) return exact[0];
  if (target.length < 10) return null;
  const suffix = target.slice(-10);
  const loose = candidates.filter((c) => {
    const d = normalizePhone(c.phone);
    return !!d && d.length >= 10 && d.slice(-10) === suffix;
  });
  return loose.length === 1 ? loose[0] : null;
}

export function waDeepLink(
  phone: string | null | undefined,
  text?: string,
): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  const encoded = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${encoded}`;
}

export function whatsappConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function graphFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, cache: "no-store" });
}

/** Send a WhatsApp text message. Falls back to a simulated send in sandbox mode. */
export async function sendWhatsAppText(
  to: string,
  body: string,
): Promise<{ sent: boolean; simulated: boolean; id?: string; error?: string }> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { sent: false, simulated: true, error: "whatsapp-not-configured" };
  }
  try {
    const res = await graphFetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as AnyRecord;
    if (!res.ok) {
      const err = asRecord(json.error);
      return {
        sent: false,
        simulated: false,
        error: err ? String(err.message ?? res.status) : String(res.status),
      };
    }
    const messages = asArray(json.messages);
    const first = asRecord(messages[0]);
    return {
      sent: true,
      simulated: false,
      id: first ? (str(first.id) ?? undefined) : undefined,
    };
  } catch (error) {
    return { sent: false, simulated: false, error: (error as Error).message };
  }
}

/** Resolve a temporary download URL for media (bills / receipts). */
export async function fetchMediaUrl(
  mediaId: string,
): Promise<{ url: string | null; mimeType: string | null; error?: string; status?: number }> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { url: null, mimeType: null, error: "whatsapp-not-configured" };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) {
    return { url: null, mimeType: null, error: "invalid-media-id", status: 400 };
  }
  try {
    const res = await graphFetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => ({}))) as AnyRecord;
    if (!res.ok) {
      const err = asRecord(json.error);
      return {
        url: null,
        mimeType: null,
        error: err ? String(err.message ?? res.status) : String(res.status),
        status: res.status,
      };
    }
    return { url: str(json.url), mimeType: str(json.mime_type) };
  } catch (error) {
    return { url: null, mimeType: null, error: (error as Error).message };
  }
}

/** Transient failures worth retrying from the sync queue. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export type MediaResponse =
  | { ok: true; res: Response; mimeType: string | null }
  | { ok: false; error: string; retryable: boolean };

/**
 * Resolve + open a WhatsApp media download. The returned Response body can be
 * streamed; the bearer token stays on the server.
 */
export async function openWhatsAppMedia(mediaId: string): Promise<MediaResponse> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, error: "whatsapp-not-configured", retryable: false };
  const resolved = await fetchMediaUrl(mediaId);
  if (!resolved.url) {
    const err = resolved.error ?? "no-url";
    return {
      ok: false,
      error: `media-lookup:${err}`,
      // Network errors (no status) / 5xx are transient; 4xx (expired / unknown id) are not.
      retryable: resolved.status === undefined ? err !== "whatsapp-not-configured" : isRetryableHttpStatus(resolved.status),
    };
  }
  try {
    const res = await graphFetch(resolved.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ok: false, error: `download-${res.status}`, retryable: isRetryableHttpStatus(res.status) };
    }
    return {
      ok: true,
      res,
      mimeType: resolved.mimeType ?? res.headers.get("content-type"),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message, retryable: true };
  }
}

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** Download WhatsApp media bytes into memory (for OCR / transcription only). */
export async function downloadWhatsAppMedia(
  mediaId: string | null,
): Promise<{ bytes: Buffer | null; mimeType: string | null; error?: string; retryable: boolean }> {
  if (!mediaId) return { bytes: null, mimeType: null, error: "no-media-id", retryable: false };
  const opened = await openWhatsAppMedia(mediaId);
  if (!opened.ok) return { bytes: null, mimeType: null, error: opened.error, retryable: opened.retryable };
  const declared = Number.parseInt(opened.res.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_MEDIA_BYTES) {
    return { bytes: null, mimeType: opened.mimeType, error: "media-too-large", retryable: false };
  }
  try {
    const bytes = Buffer.from(await opened.res.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) {
      return { bytes: null, mimeType: opened.mimeType, error: "media-too-large", retryable: false };
    }
    return { bytes, mimeType: opened.mimeType, retryable: false };
  } catch (error) {
    return { bytes: null, mimeType: null, error: (error as Error).message, retryable: true };
  }
}
