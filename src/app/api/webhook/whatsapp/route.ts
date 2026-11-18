import { after } from "next/server";
import { db } from "@/db";
import { syncQueue } from "@/db/schema";
import { clientKey, fail, ok, rateLimit } from "@/lib/api";
import { getSettings, logAudit } from "@/lib/settings";
import { processStoredMessageSafe, recordInboundMessage } from "@/lib/ingest";
import { normalizeWebhook, verifySignature } from "@/lib/wa";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // allow time for image OCR after the reply

/** Webhook subscription verification handshake (Meta requires an echo). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const settings = await getSettings();
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || settings.webhookVerifyToken;

  if (mode === "subscribe" && token && token === expected) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return fail("forbidden", 403);
}

/**
 * Inbound WhatsApp messages land here. Every payload is persisted before
 * parsing so nothing is lost if the extraction pipeline fails.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (!rateLimit(clientKey(req, "webhook"), 120, 60_000)) {
    return fail("rate-limited", 429);
  }

  const signatureResult = verifySignature(raw, signature, process.env.WHATSAPP_APP_SECRET);
  if (!signatureResult.ok) {
    await logAudit({
      entityType: "webhook",
      action: "webhook.rejected",
      actor: "meta",
      summary: `Signature verification failed: ${signatureResult.reason}`,
    });
    return fail("invalid-signature", 401, { reason: signatureResult.reason });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    await db.insert(syncQueue).values({
      kind: "webhook",
      payload: { raw: raw.slice(0, 8000) } as never,
      status: "pending",
      lastError: "invalid-json",
    });
    return fail("invalid-json", 400);
  }

  const normalized = normalizeWebhook(payload);
  if (normalized.messages.length === 0) {
    return ok({ received: 0, results: [] });
  }

  // 1) Persist every message first (idempotent on wa_message_id) so nothing is
  //    lost; 2) acknowledge Meta; 3) run media download / OCR / parsing after
  //    the response. Failures there land in sync_queue for /api/sync.
  const results = [];
  const toProcess: number[] = [];
  for (const message of normalized.messages) {
    try {
      const outcome = await recordInboundMessage(message);
      results.push({ waMessageId: message.waMessageId, messageId: outcome.messageId, status: outcome.status });
      if (outcome.status === "pending") toProcess.push(outcome.messageId);
    } catch (error) {
      await db.insert(syncQueue).values({
        kind: "webhook",
        payload: message as never,
        status: "pending",
        lastError: (error as Error).message,
        attempts: 1,
      });
      results.push({
        waMessageId: message.waMessageId,
        status: "failed",
        note: (error as Error).message,
      });
    }
  }

  if (toProcess.length) {
    after(async () => {
      for (const id of toProcess) {
        await processStoredMessageSafe(id);
      }
    });
  }

  // Always 200 so Meta does not hammer retries; failures live in sync_queue.
  return ok({ received: normalized.messages.length, results });
}
