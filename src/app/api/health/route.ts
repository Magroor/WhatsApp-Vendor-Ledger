import { sql } from "drizzle-orm";
import { db } from "@/db";
import { whatsappConfigured } from "@/lib/wa";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Time two queries: the first may include connecting / waking the database,
    // the second is the real round-trip latency from this server to the database.
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    await db.execute(sql`select 1`);
    const roundTripMs = Date.now() - t1;
    // Startup swallows migration errors, so check the newest table really exists.
    const exists = (q: ReturnType<typeof sql>) => db.execute(q).then(() => true, () => false);
    const checks = await Promise.all([
      exists(sql`select 1 from media_blobs limit 1`),
      exists(sql`select 1 from vendor_aliases limit 1`),
      exists(sql`select 1 from payment_allocations limit 1`),
      exists(sql`select 1 from push_subscriptions limit 1`),
      exists(sql`select kind from vendors limit 1`),
    ]);
    const names = ["media_blobs", "vendor_aliases", "payment_allocations", "push_subscriptions", "vendors.kind"];
    const missing = names.filter((_, i) => !checks[i]);
    const photosTable = checks[0];
    return Response.json({
      // "degraded" if a migration did not apply (startup never blocks the site on migration errors).
      status: missing.length === 0 ? "ok" : "degraded",
      schema: missing.length === 0 ? "complete" : `missing: ${missing.join(", ")}`,
      photoStorage: photosTable ? "ready" : "missing (run migrations)",
      database: "connected",
      dbFirstQueryMs: firstMs,
      dbRoundTripMs: roundTripMs, // under ~30 is good; 150+ means server and database are far apart
      serverRegion: process.env.VERCEL_REGION ?? null,
      databaseUrlSet: Boolean(process.env.DATABASE_URL),
      passwordSet: Boolean(process.env.APP_PASSWORD),
      whatsapp: whatsappConfigured() ? "configured" : "sandbox",
      time: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      {
        status: "degraded",
        database: "error",
        databaseUrlSet: Boolean(process.env.DATABASE_URL),
        // Public page: never show raw database errors (they can name tables or hosts) in production.
        error: process.env.NODE_ENV === "production" ? "database unavailable" : (error as Error).message,
      },
      { status: 500 },
    );
  }
}
