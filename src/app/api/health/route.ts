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
    return Response.json({
      status: "ok",
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
        error: (error as Error).message,
      },
      { status: 500 },
    );
  }
}
