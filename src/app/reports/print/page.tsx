import PrintButton from "@/components/PrintButton";
import { parseId } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { getReportPage } from "@/lib/queries";
import type { PeriodType, ReportLineItem } from "@/lib/reports";
import { fmtDate, fmtDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

// Print CSS lives here (globals.css is shared). Works in iOS Safari's print
// renderer: A4 page box, exact colours, repeated table headers, no row splits.
const PRINT_CSS = `
@page { size: A4; margin: 12mm; }
.print-sheet { -webkit-text-size-adjust: 100%; }
.print-sheet table { border-collapse: collapse; }
.print-sheet .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
@media print {
  html, body { background: #fff !important; color: #000 !important; }
  .app-shell, main { padding: 0 !important; margin: 0 !important; max-width: none !important; background: #fff !important; }
  .print-sheet { max-width: none !important; padding: 0 !important; box-shadow: none !important; }
  .print-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-sheet thead { display: table-header-group; }
  .print-sheet tr, .print-sheet .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  .print-sheet h2 { break-after: avoid; page-break-after: avoid; }
}
`;

export default async function PrintReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; anchor?: string; vendorId?: string }>;
}) {
  const params = await searchParams;
  const period: PeriodType =
    params.period === "weekly" || params.period === "yearly" ? params.period : "monthly";
  const vendorId = parseId(params.vendorId) ?? undefined;

  const { report, settings, timeZone } = await getReportPage(period, params.anchor ?? null, vendorId);
  const s = report.summary;
  const currency = report.currency;
  const vendorName = vendorId ? report.vendor?.name ?? `Vendor ${vendorId}` : null;

  const q = new URLSearchParams({ period, anchor: report.period.start });
  if (vendorId) q.set("vendorId", String(vendorId));
  const backHref = `/reports?${q.toString()}`;
  const csvHref = `/api/reports/export?${q.toString()}`;

  const itemsByTx = new Map<number, ReportLineItem[]>();
  for (const li of report.lineItems ?? []) {
    const list = itemsByTx.get(li.transactionId) ?? [];
    list.push(li);
    itemsByTx.set(li.transactionId, list);
  }
  const entries = report.entries ?? report.topTransactions;
  const runningBalances = entries.reduce<number[]>((acc, t) => {
    const prev = acc.length ? acc[acc.length - 1] : report.openingBalanceMinor;
    acc.push(prev + (t.entryType === "credit" ? t.amountMinor : -t.amountMinor));
    return acc;
  }, []);

  return (
    <div className="print-sheet mx-auto max-w-[720px] bg-white px-5 py-6 text-black">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <PrintButton
        backHref={backHref}
        csvHref={csvHref}
        title={`${settings.businessName} — ${vendorName ? `${vendorName} · ` : ""}${report.period.label}`}
      />
      <header className="border-b border-black/20 pb-3">
        <h1 className="text-2xl font-bold">{settings.businessName}</h1>
        <p className="text-sm font-semibold">{vendorName ?? "All vendors"}</p>
        <p className="text-sm">
          {report.period.label} ledger report · {fmtDate(report.period.startDay ?? report.period.start, timeZone)} →{" "}
          {fmtDate(report.period.endDay ?? report.period.end, timeZone)}
        </p>
        <p className="text-xs text-black/60">
          Generated {fmtDateTime(report.generatedAt, timeZone)} ({timeZone}) · {report.period.type} period (
          {report.period.key})
        </p>
      </header>

      <section className="avoid-break mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded border border-black/15 p-3">
          <p className="text-xs uppercase tracking-wide text-black/60">Credit (billed)</p>
          <p className="text-lg font-bold">{formatMinor(s.creditMinor, currency)}</p>
          <p className="text-xs">{s.creditCount} bills</p>
        </div>
        <div className="rounded border border-black/15 p-3">
          <p className="text-xs uppercase tracking-wide text-black/60">Debit (paid)</p>
          <p className="text-lg font-bold">{formatMinor(s.debitMinor, currency)}</p>
          <p className="text-xs">{s.debitCount} payments</p>
        </div>
        <div className="rounded border border-black/15 p-3">
          <p className="text-xs uppercase tracking-wide text-black/60">Opening balance</p>
          <p className="text-lg font-bold">{formatMinor(report.openingBalanceMinor, currency)}</p>
        </div>
        <div className="rounded border border-black/15 p-3">
          <p className="text-xs uppercase tracking-wide text-black/60">Closing balance</p>
          <p className="text-lg font-bold">{formatMinor(report.closingBalanceMinor, currency)}</p>
          <p className="text-xs">net {formatMinor(s.netMinor, currency)}</p>
        </div>
      </section>

      {!vendorId ? (
        <section className="mt-5">
          <h2 className="text-base font-bold">Per-vendor summary</h2>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="border-b border-black/20 text-black/60">
              <tr>
                <th className="py-1">Vendor</th>
                <th className="num py-1">Credit</th>
                <th className="num py-1">Debit</th>
                <th className="num py-1">Net</th>
                <th className="num py-1">Entries</th>
                <th className="py-1 pl-2">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {report.vendors.map((v) => (
                <tr key={v.vendorId} className="border-b border-black/10">
                  <td className="py-1">{v.vendorName}</td>
                  <td className="num py-1">{formatMinor(v.creditMinor, v.currency)}</td>
                  <td className="num py-1">{formatMinor(v.debitMinor, v.currency)}</td>
                  <td className="num py-1 font-semibold">{formatMinor(v.netMinor, v.currency)}</td>
                  <td className="num py-1">{v.txnCount}</td>
                  <td className="py-1 pl-2">{fmtDate(v.lastActivity, timeZone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="mt-5">
        <h2 className="text-base font-bold">{report.entries ? "Entries & order details" : "Top entries"}</h2>
        {entries.length === 0 ? (
          <p className="mt-2 text-xs text-black/60">No confirmed entries in this period.</p>
        ) : (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="border-b border-black/20 text-black/60">
              <tr>
                <th className="py-1">Date</th>
                {!vendorId ? <th className="py-1">Vendor</th> : null}
                <th className="py-1">Ref / details</th>
                <th className="num py-1">Credit</th>
                <th className="num py-1">Debit</th>
                {report.entries ? <th className="num py-1">Balance</th> : null}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-black/10 text-black/60">
                <td className="py-1" colSpan={vendorId ? 2 : 3}>
                  Opening balance
                </td>
                <td className="num py-1" />
                <td className="num py-1" />
                {report.entries ? (
                  <td className="num py-1">{formatMinor(report.openingBalanceMinor, currency)}</td>
                ) : null}
              </tr>
              {entries.map((t, idx) => {
                const running = runningBalances[idx];
                const items = itemsByTx.get(t.id) ?? [];
                return (
                  <tr key={t.id} className="border-b border-black/10 align-top">
                    <td className="py-1 pr-1 whitespace-nowrap">{fmtDate(t.occurredAt, timeZone)}</td>
                    {!vendorId ? <td className="py-1 pr-1">{t.vendorName}</td> : null}
                    <td className="py-1 pr-1">
                      <span className="font-semibold uppercase">{t.entryType === "credit" ? "CR" : "DR"}</span>{" "}
                      {t.reference ? `#${t.reference}` : `Entry ${t.id}`}
                      {t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ""}
                      {t.description ? <span className="block text-black/60">{t.description}</span> : null}
                      {items.length ? (
                        <ul className="mt-0.5 text-black/70">
                          {items.map((li, i) => (
                            <li key={`${t.id}-${i}`}>
                              {li.qty}
                              {li.unit ? ` ${li.unit}` : ""} × {li.name}
                              {li.unitPriceMinor !== null ? ` @ ${formatMinor(li.unitPriceMinor, li.currency)}` : ""}
                              {li.lineTotalMinor !== null ? ` = ${formatMinor(li.lineTotalMinor, li.currency)}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td className="num py-1">
                      {t.entryType === "credit" ? formatMinor(t.amountMinor, t.currency) : ""}
                    </td>
                    <td className="num py-1">
                      {t.entryType === "debit" ? formatMinor(t.amountMinor, t.currency) : ""}
                    </td>
                    {report.entries ? (
                      <td className="num py-1 font-semibold">{formatMinor(running, currency)}</td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="avoid-break mt-5">
        <h2 className="text-base font-bold">Credit aging</h2>
        <table className="mt-2 w-full text-left text-xs">
          <thead className="border-b border-black/20 text-black/60">
            <tr>
              <th className="py-1">Bucket (bill age)</th>
              <th className="num py-1">Open bills</th>
              <th className="num py-1">Amount</th>
            </tr>
          </thead>
          <tbody>
            {report.aging.map((b) => (
              <tr key={b.label} className="border-b border-black/10">
                <td className="py-1">{b.label}</td>
                <td className="num py-1">{b.count}</td>
                <td className="num py-1">{formatMinor(b.amountMinor, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-black/60">
          As of {fmtDate(report.agingAsOf ?? report.generatedAt, timeZone)}; payments settle oldest bills first.
        </p>
      </section>

      {report.openLots.length ? (
        <section className="mt-5">
          <h2 className="text-base font-bold">Open bills</h2>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="border-b border-black/20 text-black/60">
              <tr>
                {!vendorId ? <th className="py-1">Vendor</th> : null}
                <th className="py-1">Bill</th>
                <th className="py-1">Due</th>
                <th className="num py-1">Original</th>
                <th className="num py-1">Remaining</th>
                <th className="num py-1">Age</th>
                <th className="num py-1">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {report.openLots.map((lot) => (
                <tr key={lot.transactionId} className="border-b border-black/10">
                  {!vendorId ? <td className="py-1">{lot.vendorName}</td> : null}
                  <td className="py-1">
                    {lot.isOpening ? "Opening balance" : fmtDate(lot.occurredAt, timeZone)}
                    {!lot.isOpening && lot.reference ? ` · #${lot.reference}` : ""}
                  </td>
                  <td className="py-1">{lot.dueDate ? fmtDate(lot.dueDate) : "—"}</td>
                  <td className="num py-1">{formatMinor(lot.originalMinor, lot.currency)}</td>
                  <td className="num py-1 font-semibold">{formatMinor(lot.remainingMinor, lot.currency)}</td>
                  <td className="num py-1">{lot.ageDays}d</td>
                  <td className="num py-1">{lot.daysOverdue ? `${lot.daysOverdue}d` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <footer className="mt-6 border-t border-black/20 pt-3 text-[10px] text-black/60">
        Generated automatically by KhataLink from WhatsApp messages and images. Every entry links back
        to its source message for dispute resolution. Only confirmed entries are included (drafts and
        voided entries excluded). Period {report.period.start} → {report.period.end} (UTC), business
        time zone {timeZone}.
      </footer>
    </div>
  );
}
