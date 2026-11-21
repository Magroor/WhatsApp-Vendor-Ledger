import Link from "next/link";
import { notFound } from "next/navigation";
import StatementActions from "@/components/StatementActions";
import { formatMinor } from "@/lib/money";
import { businessTimeZone } from "@/lib/queries";
import { getSettings } from "@/lib/settings";
import {
  STATEMENT_RANGES,
  buildStatementText,
  loadStatement,
  parseStatementRange,
} from "@/lib/statement";

export const dynamic = "force-dynamic";

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #statement-sheet, #statement-sheet * { visibility: visible !important; }
  #statement-sheet { position: absolute; left: 0; top: 0; width: 100%; background: #fff !important; color: #000 !important; box-shadow: none !important; border: 0 !important; }
  #statement-sheet * { color: #000 !important; background: transparent !important; border-color: #999 !important; }
}
`;

export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { id } = await params;
  const { range: rangeParam } = await searchParams;
  const vendorId = Number.parseInt(id, 10);
  if (!Number.isFinite(vendorId) || vendorId <= 0) notFound();

  const range = parseStatementRange(rangeParam);
  const tz = businessTimeZone(await getSettings());
  const st = await loadStatement(vendorId, range, tz);
  if (!st) notFound();

  const fm = (n: number) => formatMinor(n, st.currency);
  const text = buildStatementText(st.vendor, st.rows, st.openingMinor, st.closingMinor, st.currency, st.rangeLabel);
  const due = st.closingMinor;

  return (
    <div className="space-y-4 rise">
      <style>{PRINT_CSS}</style>
      <div className="no-print">
        <Link href={`/vendors/${st.vendor.id}`} className="tap-link tiny text-indigo-300">
          ← Back to {st.vendor.name}
        </Link>
        <nav className="chip-scroll mt-1 flex gap-2" aria-label="Statement period">
          {STATEMENT_RANGES.map((r) => (
            <Link
              key={r.value}
              href={`/vendors/${st.vendor.id}/statement?range=${r.value}`}
              className="chip"
              data-active={range === r.value}
              aria-current={range === r.value ? "page" : undefined}
            >
              {r.label}
            </Link>
          ))}
        </nav>
      </div>

      <section id="statement-sheet" className="card print-sheet space-y-3">
        <div>
          <p className="tiny muted font-semibold uppercase tracking-wide">Vendor statement</p>
          <h1 className="h1 mt-1 break-words">{st.vendor.name}</h1>
          {st.vendor.phone ? <p className="tiny muted">{st.vendor.phone}</p> : null}
          <p className="tiny muted mt-1">
            {st.rangeLabel} · generated {st.generatedLabel}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-2">
          <span className="tiny muted">Opening balance</span>
          <span className="font-bold tabular-nums">{fm(st.openingMinor)}</span>
        </div>

        {st.rows.length === 0 ? (
          <p className="tiny muted">No entries in this period.</p>
        ) : (
          <table className="w-full table-fixed border-collapse text-[12px]">
            <caption className="sr-only">Statement entries</caption>
            <thead>
              <tr className="text-left muted">
                <th scope="col" className="w-[34%] py-1 pr-1 font-semibold">
                  Date / details
                </th>
                <th scope="col" className="w-[22%] py-1 px-1 text-right font-semibold">
                  Bill (CR)
                </th>
                <th scope="col" className="w-[21%] py-1 px-1 text-right font-semibold">
                  Paid (DR)
                </th>
                <th scope="col" className="w-[23%] py-1 pl-1 text-right font-semibold">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {st.rows.map((r) => (
                <tr key={r.id} className="border-t border-white/10 align-top">
                  <td className="py-1.5 pr-1">
                    <span className="block font-semibold">{r.dateLabel}</span>
                    {r.reference ? <span className="block break-words muted">#{r.reference}</span> : null}
                    {r.description ? <span className="block break-words muted">{r.description}</span> : null}
                  </td>
                  <td className="py-1.5 px-1 text-right tabular-nums break-words">
                    {r.entryType === "credit" ? fm(r.amountMinor) : ""}
                  </td>
                  <td className="py-1.5 px-1 text-right tabular-nums break-words">
                    {r.entryType === "debit" ? fm(r.amountMinor) : ""}
                  </td>
                  <td className="py-1.5 pl-1 text-right font-semibold tabular-nums break-words">
                    {fm(r.balanceMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="space-y-1 border-t border-white/10 pt-2">
          <div className="flex justify-between gap-3 tiny muted">
            <span>Total billed</span>
            <span className="tabular-nums">{fm(st.creditMinor)}</span>
          </div>
          <div className="flex justify-between gap-3 tiny muted">
            <span>Total paid</span>
            <span className="tabular-nums">{fm(st.debitMinor)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-[13px]">Closing balance</span>
            <span className="font-bold tabular-nums">{fm(st.closingMinor)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/15 p-3">
          <span className="text-[15px] font-extrabold">{due < 0 ? "Advance paid" : "Amount due now"}</span>
          <span className="text-[20px] font-extrabold tabular-nums">{fm(Math.abs(due))}</span>
        </div>
      </section>

      <StatementActions text={text} phone={st.vendor.phone} title={`Statement for ${st.vendor.name}`} />
    </div>
  );
}
