import { sql } from "drizzle-orm";
import { db } from "@/db";
import { whatsappConfigured } from "@/lib/wa";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({
      status: "ok",
      database: "connected",
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
