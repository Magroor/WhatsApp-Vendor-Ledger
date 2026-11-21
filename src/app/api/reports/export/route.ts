import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { fail } from "@/lib/api";
import { businessTimeZone } from "@/lib/queries";
import { buildReport, fileSlug, parseReportQuery, reportToCsv } from "@/lib/reports";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const settings = await getSettings();
  const timeZone = businessTimeZone(settings);
  // Same validation as /api/reports: bad params are a 400, never "now" / all vendors.
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
  const isCustomer = report.kind === "customer";
  const vendorName = vendorId ? report.vendor?.name ?? `Vendor ${vendorId}` : isCustomer ? "All customers" : "All vendors";
  // UTF-8 BOM so Excel opens Urdu / non-ASCII names correctly.
  const csv = `﻿${reportToCsv(report, vendorName)}`;
  const filename = `ledger-${vendorId ? `${fileSlug(vendorName)}-` : isCustomer ? "customers-" : ""}${period}-${report.period.key}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
