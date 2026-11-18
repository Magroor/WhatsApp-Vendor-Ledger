import { after } from "next/server";
import { fail, ok, readJson } from "@/lib/api";
import { processStoredMessageSafe, recordInboundMessage } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Simulates one incoming WhatsApp text through the same pipeline as the real
 * webhook, for testing. It skips Meta's signature check, so it is only
 * available behind the app login: in production APP_PASSWORD must be set.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production" && !process.env.APP_PASSWORD) {
    return fail("Set APP_PASSWORD first. Test messages are only allowed behind the app login.", 403);
  }
  const body = await readJson<{ text?: string; from?: string; name?: string }>(req);
  const text = (body.text ?? "").trim().slice(0, 4000);
  if (!text) return fail("Type a message first.");
  const from = (body.from ?? "923001112233").replace(/\D/g, "").slice(0, 15) || "923001112233";

  const outcome = await recordInboundMessage({
    waMessageId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    profileName: (body.name ?? "").trim().slice(0, 80) || null,
    receivedAt: new Date(),
    messageType: "text",
    body: text,
    caption: null,
    mediaId: null,
    mimeType: null,
    phoneNumberId: null,
  });
  if (outcome.status === "pending") {
    after(async () => {
      await processStoredMessageSafe(outcome.messageId);
    });
  }
  return ok({ received: 1, messageId: outcome.messageId, status: outcome.status });
}
