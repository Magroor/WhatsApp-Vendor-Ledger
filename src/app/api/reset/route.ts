import { sql } from "drizzle-orm";
import { db } from "@/db";
import { clientKey, fail, ok, rateLimit, readJson } from "@/lib/api";
import { logAudit } from "@/lib/settings";

export const dynamic = "force-dynamic";

async function counts() {
  const r = await db.execute(sql`
    select
      (select count(*)::int from vendors where name <> 'Unassigned (choose vendor)') as vendors,
      (select count(*)::int from transactions) as entries,
      (select count(*)::int from wa_messages) as messages,
      (select count(*)::int from media_blobs) as photos`);
  const row = ((r as unknown as { rows?: Array<Record<string, number>> }).rows ?? (r as unknown as Array<Record<string, number>>))[0];
  return {
    vendors: Number(row?.vendors ?? 0),
    entries: Number(row?.entries ?? 0),
    messages: Number(row?.messages ?? 0),
    photos: Number(row?.photos ?? 0),
  };
}

/** What a reset would delete (so the button can show real numbers). */
export async function GET() {
  return ok(await counts());
}

/**
 * Reset test data. Empties entries, messages, bill photos, reminders, reports and the
 * audit log; keeps the database tables and Settings. `keepVendors: true` also keeps vendors.
 * Needs the app login in production and the word RESET as confirmation.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production" && !process.env.APP_PASSWORD) {
    return fail("Set APP_PASSWORD first. Reset is only allowed behind the app login.", 403);
  }
  if (!rateLimit(clientKey(req, "reset"), 5, 60_000)) return fail("Too many attempts. Wait a minute.", 429);
  const body = await readJson<{ confirm?: string; keepVendors?: boolean }>(req);
  if (body.confirm !== "RESET") return fail('Type RESET to confirm.', 400);

  const before = await counts();
  if (body.keepVendors) {
    await db.execute(sql`truncate table tx_items, transactions, wa_messages, media_blobs, reminders, report_snapshots, sync_queue, audit_events restart identity`);
  } else {
    await db.execute(sql`truncate table tx_items, transactions, wa_messages, media_blobs, reminders, report_snapshots, sync_queue, audit_events, vendors restart identity cascade`);
  }
  await logAudit({
    entityType: "system",
    action: "data.reset",
    actor: "user",
    summary: `Test data cleared (${body.keepVendors ? "vendors kept" : "vendors removed"}): ${before.entries} entries, ${before.messages} messages`,
  });
  return ok({ ok: true, removed: before, keptVendors: Boolean(body.keepVendors) });
}
