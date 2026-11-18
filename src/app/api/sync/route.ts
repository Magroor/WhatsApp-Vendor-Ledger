import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { syncQueue, waMessages } from "@/db/schema";
import { fail, ok, readJson } from "@/lib/api";
import {
  enqueueIngestRetry,
  processStoredMessage,
  recordInboundMessage,
  reparseMessage,
  reviveInbound,
} from "@/lib/ingest";
import { sendWhatsAppText } from "@/lib/wa";

export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 5;

export async function GET() {
  const counts = await db
    .select({ status: syncQueue.status, count: sql<number>`count(*)::int` })
    .from(syncQueue)
    .groupBy(syncQueue.status);
  const recent = await db
    .select()
    .from(syncQueue)
    .orderBy(desc(syncQueue.createdAt))
    .limit(20);
  return ok({ counts, queue: recent });
}

/** Re-run extraction/parsing for a stored message; throws if it should be retried again. */
async function reingest(messageId: number) {
  const outcome = await processStoredMessage(messageId, { retry: true });
  if (outcome.retryable) throw new Error(outcome.note ?? "extraction-retryable");
  return outcome;
}

/** Retry anything the automation pipeline could not finish while offline. */
export async function POST(req: Request) {
  const body = await readJson<{ max?: number }>(req);
  const max = Math.max(1, Math.min(50, Number(body.max) || 20));

  const pending = await db
    .select()
    .from(syncQueue)
    .where(inArray(syncQueue.status, ["pending"]))
    .orderBy(syncQueue.createdAt)
    .limit(max);

  let processed = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      if (item.kind === "send") {
        const payload = item.payload as { to?: string; body?: string };
        const result = await sendWhatsAppText(payload.to ?? "", payload.body ?? "");
        if (result.sent) {
          await db.update(syncQueue).set({ status: "done", attempts: item.attempts + 1 }).where(eq(syncQueue.id, item.id));
        } else if (result.simulated) {
          await db
            .update(syncQueue)
            .set({ status: "done", attempts: item.attempts + 1, lastError: "simulated-no-credentials" })
            .where(eq(syncQueue.id, item.id));
        } else {
          throw new Error(result.error ?? "send-failed");
        }
        processed += 1;
        continue;
      }

      const payload = (item.payload ?? {}) as { messageId?: unknown; raw?: unknown };
      if (item.kind === "ingest" && typeof payload.messageId === "number") {
        // Stored message whose extraction / parsing failed: actually re-run it.
        await reingest(payload.messageId);
      } else if (reviveInbound(item.payload)) {
        // Webhook message that never got persisted: record it, then process.
        const inbound = reviveInbound(item.payload)!;
        const recorded = await recordInboundMessage(inbound);
        if (recorded.messageId) await reingest(recorded.messageId);
      } else if (typeof payload.raw === "string") {
        // Unparseable payload: park it as an unlinked message for review.
        await db
          .insert(waMessages)
          .values({
            waMessageId: `raw-${item.id}`,
            direction: "in",
            messageType: "system",
            body: payload.raw.slice(0, 4000),
            parseStatus: "review",
          })
          .onConflictDoNothing({ target: waMessages.waMessageId });
      } else {
        throw new Error("unrecognised-queue-item");
      }
      await db
        .update(syncQueue)
        .set({ status: "done", attempts: item.attempts + 1 })
        .where(eq(syncQueue.id, item.id));
      processed += 1;
    } catch (error) {
      const attempts = item.attempts + 1;
      await db
        .update(syncQueue)
        .set({
          attempts,
          lastError: (error as Error).message.slice(0, 500),
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        })
        .where(eq(syncQueue.id, item.id));
      failed += 1;
    }
  }

  // Sweep inbound rows left in pending/processing (e.g. the post-response
  // worker was killed) that have no queue entry.
  const stale = await db
    .select({ id: waMessages.id })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.direction, "in"),
        inArray(waMessages.parseStatus, ["pending", "processing"]),
        sql`${waMessages.createdAt} < now() - interval '2 minutes'`,
      ),
    )
    .orderBy(waMessages.createdAt)
    .limit(max);
  let swept = 0;
  for (const row of stale) {
    try {
      await reingest(row.id);
      swept += 1;
    } catch (error) {
      await enqueueIngestRetry(row.id, (error as Error).message).catch(() => undefined);
      failed += 1;
    }
  }

  return ok({ scanned: pending.length, processed, failed, swept });
}

/** Manual retry of a single message's extraction. */
export async function PATCH(req: Request) {
  const body = await readJson<{ messageId?: number }>(req);
  if (!body.messageId) return fail("messageId required", 400);
  try {
    const result = await reparseMessage(body.messageId);
    if (!result) return fail("message not found", 404);
    return ok(result);
  } catch (error) {
    return fail((error as Error).message, 400);
  }
}
