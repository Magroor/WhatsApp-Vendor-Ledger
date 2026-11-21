import { learnFromMessage } from "@/lib/aliases";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { transactions, vendors, waMessages } from "@/db/schema";
import { clientKey, fail, ok, parseId, parsePositiveAmount, rateLimit, readJson, readJsonObject } from "@/lib/api";
import { ingestInboundMessage, reparseMessage } from "@/lib/ingest";
import type { EntryType } from "@/lib/parse";
import type { WaInboundMessage } from "@/lib/wa";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const vendorParam = url.searchParams.get("vendorId");
  const vendorId = parseId(vendorParam);
  if (vendorParam && !vendorId) return fail("invalid vendorId");
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, rawLimit) : 50;

  const filters = [];
  if (status && status !== "all") {
    filters.push(
      status === "pending"
        ? inArray(waMessages.parseStatus, ["pending", "processing", "review", "failed"])
        : eq(waMessages.parseStatus, status),
    );
  }
  if (vendorId) filters.push(eq(waMessages.vendorId, vendorId));

  const rows = await db
    .select({
      id: waMessages.id,
      waMessageId: waMessages.waMessageId,
      vendorId: waMessages.vendorId,
      vendorName: vendors.name,
      direction: waMessages.direction,
      messageType: waMessages.messageType,
      body: waMessages.body,
      caption: waMessages.caption,
      ocrText: waMessages.ocrText,
      mimeType: waMessages.mimeType,
      mediaId: waMessages.mediaId,
      mediaUrl: waMessages.mediaUrl,
      fromPhone: waMessages.fromPhone,
      profileName: waMessages.profileName,
      receivedAt: waMessages.receivedAt,
      parseStatus: waMessages.parseStatus,
      parseConfidence: waMessages.parseConfidence,
      extractionSource: waMessages.extractionSource,
      transactionId: transactions.id,
      txAmountMinor: transactions.amountMinor,
      txEntryType: transactions.entryType,
      txStatus: transactions.status,
    })
    .from(waMessages)
    .leftJoin(vendors, eq(vendors.id, waMessages.vendorId))
    .leftJoin(transactions, eq(transactions.messageId, waMessages.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(waMessages.receivedAt))
    .limit(limit);

  const counts = await db
    .select({ status: waMessages.parseStatus, count: sql<number>`count(*)::int` })
    .from(waMessages)
    .groupBy(waMessages.parseStatus);

  return ok({ messages: rows, counts });
}

type SimulateBody = {
  text?: string;
  from?: string;
  profileName?: string;
  messageType?: string;
  caption?: string;
  mediaId?: string;
  receivedAt?: string;
};

/** Capture endpoint: paste/forward a WhatsApp bill from the device into the ledger. */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "capture"), 60, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<SimulateBody>(req);
  const text = (body.text ?? body.caption ?? "").trim();
  if (!text && !body.mediaId) return fail("message text or mediaId required");

  const now = body.receivedAt ? new Date(body.receivedAt) : new Date();
  const inbound: WaInboundMessage = {
    waMessageId: `sim-${now.getTime()}-${Math.random().toString(36).slice(2, 9)}`,
    from: body.from?.replace(/[^\d]/g, "") || "920000000001",
    profileName: body.profileName ?? null,
    receivedAt: Number.isNaN(now.getTime()) ? new Date() : now,
    messageType: (["text", "image", "audio", "document"].includes(body.messageType ?? "")
      ? body.messageType
      : "text") as WaInboundMessage["messageType"],
    body: text || null,
    caption: body.caption ?? null,
    mediaId: body.mediaId ?? null,
    mimeType: body.messageType === "image" ? "image/jpeg" : null,
    phoneNumberId: null,
  };

  const outcome = await ingestInboundMessage(inbound);
  return ok(outcome, 201);
}

type PatchBody = {
  action?: "reparse" | "ignore" | "link";
  entryType?: EntryType;
  amount?: string | number;
  vendorId?: number;
};

export async function PATCH(req: Request) {
  const url = new URL(req.url);
  const id = parseId(url.searchParams.get("id"));
  if (!id) return fail("id required");
  const read = await readJsonObject<PatchBody>(req, 64 * 1024);
  if (!read.ok) return fail(read.error, read.status);
  const body = read.body;

  // "link" = reparse with a chosen vendor. A missing action means reparse (old clients).
  if (body.action !== undefined && body.action !== "reparse" && body.action !== "ignore" && body.action !== "link") {
    return fail("action must be reparse, ignore or link");
  }

  if (body.action === "ignore") {
    const updated = await db
      .update(waMessages)
      .set({ parseStatus: "ignored" })
      .where(eq(waMessages.id, id))
      .returning({ id: waMessages.id });
    if (!updated[0]) return fail("message not found", 404);
    return ok({ status: "ignored" });
  }

  if (body.entryType !== undefined && body.entryType !== "credit" && body.entryType !== "debit") {
    return fail("entryType must be credit or debit");
  }
  let amountMinor: number | undefined;
  if (body.amount !== undefined && body.amount !== "") {
    const parsed = parsePositiveAmount(body.amount);
    if (!parsed.ok) return fail(parsed.error);
    amountMinor = parsed.minor;
  }
  const vendorId = body.vendorId !== undefined ? parseId(String(body.vendorId)) : null;
  if (body.vendorId !== undefined && !vendorId) return fail("invalid vendorId");

  const override = {
    entryType: body.entryType,
    amountMinor,
    vendorId: vendorId ?? undefined,
  };
  try {
    const result = await reparseMessage(id, override);
    if (!result) return fail("message not found", 404);
    // A person chose the vendor: remember how this bill names it so the next one is automatic.
    let learned: string[] = [];
    if (override.vendorId) {
      try {
        learned = (await learnFromMessage(id, override.vendorId)).learned;
      } catch {
        /* learning is best-effort */
      }
    }
    return ok({
      ok: true,
      transactionId: result.transactionId,
      posted: result.posted,
      reason: result.reason,
      draft: result.draft,
      learned,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "vendor-not-found") return fail(message, 404);
    // Never echo driver errors (they contain the SQL text and parameters).
    console.error("messages PATCH failed", error);
    return fail("reparse failed", 500);
  }
}
