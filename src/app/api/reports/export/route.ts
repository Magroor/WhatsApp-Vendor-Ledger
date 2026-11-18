import { parseId } from "@/lib/api";
import { businessTimeZone } from "@/lib/queries";
import { buildReport, fileSlug, parseAnchor, reportToCsv, type PeriodType } from "@/lib/reports";
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
  const anchor = parseAnchor(url.searchParams.get("anchor"), timeZone) ?? new Date();

  const report = await buildReport({
    type: period,
    anchor,
    vendorId,
    currency: settings.currency,
    timeZone,
  });
  const vendorName = vendorId ? report.vendor?.name ?? `Vendor ${vendorId}` : "All vendors";
  // UTF-8 BOM so Excel opens Urdu / non-ASCII names correctly.
  const csv = `﻿${reportToCsv(report, vendorName)}`;
  const filename = `ledger-${vendorId ? `${fileSlug(vendorName)}-` : ""}${period}-${report.period.key}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
