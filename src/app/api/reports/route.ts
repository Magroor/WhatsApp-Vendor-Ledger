import { db } from "@/db";
import { reportSnapshots } from "@/db/schema";
import { fail, ok, parseId } from "@/lib/api";
import { businessTimeZone } from "@/lib/queries";
import { buildReport, parseAnchor, type PeriodType } from "@/lib/reports";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const PERIODS: PeriodType[] = ["weekly", "monthly", "yearly"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const periodParam = (url.searchParams.get("period") ?? "monthly") as PeriodType;
  const period = PERIODS.includes(periodParam) ? periodParam : "monthly";
  const vendorId = parseId(url.searchParams.get("vendorId")) ?? undefined;

  const settings = await getSettings();
  const timeZone = businessTimeZone(settings);
  const anchorParam = url.searchParams.get("anchor");
  const anchor = anchorParam ? parseAnchor(anchorParam, timeZone) : new Date();
  if (!anchor) return fail("invalid anchor");

  const report = await buildReport({
    type: period,
    anchor,
    vendorId,
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
