import Link from "next/link";
import ExportBar from "@/components/ExportBar";
import { Badge, Bars, Card, EmptyState, Money, SectionTitle, StatTile } from "@/components/ui";
import { parseId } from "@/lib/api";
import { formatMinor, shareOf } from "@/lib/money";
import { getReportPage, getVendorOptions } from "@/lib/queries";
import { fileSlug, type PeriodType } from "@/lib/reports";
import { fmtDate, timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";

const PERIODS: Array<{ key: PeriodType; label: string }> = [
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
];

function pctLabel(value: number): string {
  if (!value) return "—";
  return `${value > 0 ? "▲" : "▼"} ${Math.abs(value)}%`;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; anchor?: string; vendorId?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodType =
    params.period === "weekly" || params.period === "yearly" ? params.period : "monthly";
  const vendorId = parseId(params.vendorId) ?? undefined;

  const [{ settings, report, timeZone }, vendorOptions] = await Promise.all([
    getReportPage(period, params.anchor ?? null, vendorId),
    getVendorOptions(),
  ]);
  const selectedVendor = vendorId ? report.vendor ?? null : null;
  const currency = report.currency;
  const s = report.summary;
  const openTotal = report.aging.reduce((a, b) => a + b.amountMinor, 0);
  // Anchor for links/exports: the period start, so every view of this report
  // (page, CSV, print, snapshot) resolves to exactly the same period.
  const anchorIso = report.period.start;

  const shareText = [
    `${settings.businessName} — ${selectedVendor ? `${selectedVendor.name} · ` : ""}${report.period.label} report`,
    `Credit: ${formatMinor(s.creditMinor, currency)}`,
    `Debit: ${formatMinor(s.debitMinor, currency)}`,
    `Opening: ${formatMinor(report.openingBalanceMinor, currency)}`,
    `Closing balance: ${formatMinor(report.closingBalanceMinor, currency)}`,
    `Entries: ${s.creditCount + s.debitCount} across ${s.vendorCount} vendors`,
    `Open bills: ${formatMinor(openTotal, currency)}`,
  ].join("\n");

  const isCurrent = containsNow(report.period.start, report.period.end);
  // Chips / vendor picker keep the anchor only when browsing a past/future
  // period, so switching Monthly -> Weekly from "now" opens the current week.
  const keepAnchor = isCurrent ? undefined : anchorIso;
  const navQuery = (anchor: string | undefined, p: PeriodType = period) => {
    const q = new URLSearchParams({ period: p });
    if (anchor) q.set("anchor", anchor);
    if (vendorId) q.set("vendorId", String(vendorId));
    return `/reports?${q.toString()}`;
  };

  return (
    <div className="space-y-5 rise">
      <div className="chip-scroll">
        {PERIODS.map((p) => (
          <Link key={p.key} href={navQuery(keepAnchor, p.key)} className="chip" data-active={period === p.key}>
            {p.label}
          </Link>
        ))}
      </div>

      <form method="get" action="/reports" className="flex gap-2">
        <input type="hidden" name="period" value={period} />
        {keepAnchor ? <input type="hidden" name="anchor" value={keepAnchor} /> : null}
        <select name="vendorId" defaultValue={vendorId ? String(vendorId) : ""} className="field flex-1" aria-label="Vendor">
          <option value="">All vendors</option>
          {vendorOptions
            .filter((v) => !v.archived || v.id === vendorId)
            .map((v) => (
              <option key={v.id} value={String(v.id)}>
                {v.name}
              </option>
            ))}
        </select>
        <button type="submit" className="btn btn-sm">
          Apply
        </button>
      </form>

      <Card className="border-indigo-400/30 bg-indigo-500/10">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="h2 truncate">{selectedVendor ? selectedVendor.name : report.period.label}</p>
            <p className="tiny muted mt-1">
              {fmtDate(report.period.startDay ?? report.period.start, timeZone)} →{" "}
              {fmtDate(report.period.endDay ?? report.period.end, timeZone)}
              {selectedVendor ? ` · ${report.period.label}` : ""}
            </p>
          </div>
          <div className="flex gap-1">
            <Link href={navQuery(report.nav?.previous)} className="btn btn-sm" aria-label="Previous period">
              ←
            </Link>
            {!isCurrent ? (
              <Link href={navQuery(undefined)} className="btn btn-sm">
                Now
              </Link>
            ) : null}
            <Link href={navQuery(report.nav?.next)} className="btn btn-sm" aria-label="Next period">
              →
            </Link>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <StatTile
          label="Credit (billed)"
          value={formatMinor(s.creditMinor, currency, { decimals: false })}
          tone="credit"
          sub={`${s.creditCount} bills · ${pctLabel(report.delta.creditPct)} vs prev`}
        />
        <StatTile
          label="Debit (paid)"
          value={formatMinor(s.debitMinor, currency, { decimals: false })}
          tone="debit"
          sub={`${s.debitCount} payments · ${pctLabel(report.delta.debitPct)} vs prev`}
        />
        <StatTile
          label="Net moved"
          value={formatMinor(s.netMinor, currency, { decimals: false })}
          sub={`avg ${formatMinor(s.avgBillMinor, currency, { decimals: false })}`}
        />
        <StatTile
          label="Closing balance"
          value={formatMinor(report.closingBalanceMinor, currency, { decimals: false })}
          sub={`opening ${formatMinor(report.openingBalanceMinor, currency, { decimals: false })}`}
        />
      </div>

      <div>
        <SectionTitle title="Cash flow" hint="Credit vs debit through the period" />
        <Card>
          <Bars points={report.series} currency={currency} />
          <div className="mt-3 flex gap-3 tiny muted">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> credit
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-rose-400" /> debit
            </span>
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle
          title="Credit aging"
          hint={`Open bills by bill age (FIFO settlement), as of ${fmtDate(report.agingAsOf ?? report.generatedAt, timeZone)}`}
        />
        {openTotal === 0 ? (
          <EmptyState icon="✅" title="Nothing outstanding" hint="No open bills as of this period." />
        ) : (
          <Card className="space-y-3">
            {report.aging.map((bucket) => (
              <div key={bucket.label}>
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-semibold">{bucket.label}</p>
                  <p className="text-[13px] font-bold tabular-nums">
                    {formatMinor(bucket.amountMinor, currency, { decimals: false })}
                    <span className="tiny muted"> · {bucket.count} bills</span>
                  </p>
                </div>
                <div className="mt-1">
                  <Bars
                    points={[{ label: bucket.label, creditMinor: bucket.amountMinor, debitMinor: 0 }]}
                    currency={currency}
                  />
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>

      <div>
        <SectionTitle
          title={selectedVendor ? "Period breakdown" : "Per-vendor breakdown"}
          hint="Sorted by total volume"
        />
        {report.vendors.length === 0 ? (
          <EmptyState icon="📊" title="No activity" hint="No confirmed entries in this period." />
        ) : (
          <Card className="space-y-3">
            {report.vendors.slice(0, 12).map((v) => (
              <Link key={v.vendorId} href={`/vendors/${v.vendorId}`} className="block card-press">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold">{v.vendorName}</p>
                    <p className="tiny muted">
                      {v.txnCount} entries · last {timeAgo(v.lastActivity)}
                    </p>
                  </div>
                  <Money minor={v.netMinor} currency={v.currency} className="text-[14px] font-bold" decimals={false} />
                </div>
                <div className="mt-1 flex gap-2 tiny muted">
                  <span>CR {formatMinor(v.creditMinor, v.currency, { decimals: false })}</span>
                  <span>DR {formatMinor(v.debitMinor, v.currency, { decimals: false })}</span>
                  <span>{shareOf(v.creditMinor, s.creditMinor)}% of credit</span>
                </div>
              </Link>
            ))}
          </Card>
        )}
      </div>

      {report.openLots.length ? (
        <div>
          <SectionTitle title="Open bills" hint="Outstanding lots with age and overdue days" />
          <Card className="space-y-2">
            {report.openLots.map((lot) => (
              <div key={lot.transactionId} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold">
                    {lot.vendorName}{" "}
                    {lot.isOpening ? "· Opening balance" : lot.reference ? `· ${lot.reference}` : ""}
                  </p>
                  <p className="tiny muted">
                    {fmtDate(lot.occurredAt, timeZone)} · due {lot.dueDate ? fmtDate(lot.dueDate) : "n/a"} ·{" "}
                    {lot.ageDays}d old
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[13px] font-bold">{formatMinor(lot.remainingMinor, lot.currency)}</p>
                  {lot.daysOverdue > 0 ? <Badge tone="warn">{lot.daysOverdue}d late</Badge> : null}
                </div>
              </div>
            ))}
          </Card>
        </div>
      ) : null}

      <ExportBar
        period={period}
        anchor={anchorIso}
        vendorId={vendorId}
        shareText={shareText}
        fileName={`ledger-${selectedVendor ? `${fileSlug(selectedVendor.name)}-` : ""}${period}-${report.period.key}.csv`}
      />

      <Card className="border-white/5">
        <SectionTitle title="Automation summary" hint="What the pipeline did this period" />
        <ul className="tiny muted space-y-1">
          <li>WhatsApp messages parsed: {report.counts.messagesParsed}</li>
          <li>WhatsApp entries posted: {report.counts.autoPosted}</li>
          <li>Total entries: {s.creditCount + s.debitCount}</li>
          <li>Order line items: {report.lineItems?.length ?? 0}</li>
          <li>Tax captured: {formatMinor(s.taxMinor, currency, { decimals: false })}</li>
          <li>Largest single entry: {formatMinor(s.largestMinor, currency, { decimals: false })}</li>
          <li>Vendors active: {s.vendorCount}</li>
          <li>Time zone: {timeZone}</li>
        </ul>
      </Card>
    </div>
  );
}

function containsNow(startIso: string, endIso: string): boolean {
  const now = new Date().getTime();
  return now >= Date.parse(startIso) && now <= Date.parse(endIso);
}
