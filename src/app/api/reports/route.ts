import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reportSnapshots, vendors } from "@/db/schema";
import { fail, ok } from "@/lib/api";
import { businessTimeZone } from "@/lib/queries";
import { buildReport, parseReportQuery } from "@/lib/reports";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const settings = await getSettings();
  const timeZone = businessTimeZone(settings);
  const query = parseReportQuery(url.searchParams, timeZone);
  if (!query.ok) return fail(query.error);
  const { period, vendorId, anchor, kind } = query;

  if (vendorId) {
    const found = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId)).limit(1);
    if (!found[0]) return fail("vendor not found", 404);
  }

  const report = await buildReport({
    type: period,
    anchor,
    vendorId,
    kind,
    currency: settings.currency,
    timeZone,
  });

  if (url.searchParams.get("save") === "1") {
    await db.insert(reportSnapshots).values({
      vendorId: vendorId ?? null,
      periodType: period,
      periodKey: report.period.key,
      periodStart: new Date(report.period.start),
      periodEnd: new Date(report.period.end),
      payload: report as never,
    });
  }

  return ok(report);
}
