import Link from "next/link";
import { notFound } from "next/navigation";
import EntryActions from "@/components/EntryActions";
import ReminderButton from "@/components/ReminderButton";
import TransactionForm from "@/components/TransactionForm";
import { Badge, Card, Money, Progress, SectionTitle, StatTile } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import { getVendorDetail } from "@/lib/queries";
import { fmtDate, fmtDateTime, timeAgo } from "@/lib/time";
import { waDeepLink } from "@/lib/wa";

export const dynamic = "force-dynamic";

export default async function VendorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { id } = await params;
  const { filter: filterParam } = await searchParams;
  const vendorId = Number.parseInt(id, 10);
  if (!Number.isFinite(vendorId) || vendorId <= 0) notFound();

  const filter = filterParam === "credit" || filterParam === "debit" ? filterParam : "all";
  const data = await getVendorDetail(vendorId, filter);
  if (!data) notFound();

  const { vendor, timeZone } = data;
  const chatLink = waDeepLink(vendor.phone, `Assalam-o-Alaikum ${vendor.name}, khata update from KhataLink.`);
  const openTotal = data.openLots.reduce((a, l) => a + l.remainingMinor, 0);
  const oldest = data.openLots.reduce((a, l) => Math.max(a, l.ageDays), 0);
  const overdue = data.openLots.reduce((a, l) => Math.max(a, l.daysOverdue), 0);

  return (
    <div className="space-y-5 rise">
      <Card className="border-indigo-400/30 bg-indigo-500/10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="h2 truncate">{vendor.name}</p>
            <p className="tiny muted mt-1">
              {[vendor.businessType, vendor.city].filter(Boolean).join(" · ") || "Vendor"}
              {vendor.phone ? ` · ${vendor.phone}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={data.balanceMinor > 0 ? "debit" : data.balanceMinor < 0 ? "credit" : "muted"}>
                {data.balanceMinor > 0 ? "You owe" : data.balanceMinor < 0 ? "Owes you" : "Settled"}
              </Badge>
              <Badge tone="brand">Net-{vendor.creditTermsDays} terms</Badge>
              {overdue > 0 ? <Badge tone="warn">{overdue}d overdue</Badge> : null}
            </div>
          </div>
          <div className="text-right">
            <p className="tiny muted">Running balance</p>
            <Money minor={data.balanceMinor} currency={vendor.currency} className="text-[22px] font-extrabold" />
            <p className="tiny muted mt-1">
              CR {formatMinor(data.totals.credit, vendor.currency, { decimals: false })} · DR{" "}
              {formatMinor(data.totals.debit, vendor.currency, { decimals: false })}
            </p>
            {vendor.openingBalanceMinor ? (
              <p className="tiny muted">
                incl. opening {formatMinor(vendor.openingBalanceMinor, vendor.currency, { decimals: false })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {chatLink ? (
            <a className="btn btn-sm" href={chatLink} target="_blank" rel="noreferrer">
              💬 WhatsApp chat
            </a>
          ) : (
            <span className="btn btn-sm opacity-50">💬 No number</span>
          )}
          <ReminderButton vendorId={vendor.id} vendorName={vendor.name} size="md" />
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-2">
        <Link href={`/reports?period=weekly&vendorId=${vendor.id}`} className="block card-press">
          <StatTile
            label="Week net"
            value={formatMinor(data.periodTotals.weekly.creditMinor - data.periodTotals.weekly.debitMinor, vendor.currency, { decimals: false })}
            sub={`${data.periodTotals.weekly.count} entries · ${data.periodLabels.weekly}`}
          />
        </Link>
        <Link href={`/reports?period=monthly&vendorId=${vendor.id}`} className="block card-press">
          <StatTile
            label="Month net"
            value={formatMinor(data.periodTotals.monthly.creditMinor - data.periodTotals.monthly.debitMinor, vendor.currency, { decimals: false })}
            sub={`${data.periodTotals.monthly.count} entries · ${data.periodLabels.monthly}`}
          />
        </Link>
        <Link href={`/reports?period=yearly&vendorId=${vendor.id}`} className="block card-press">
          <StatTile
            label="Year net"
            value={formatMinor(data.periodTotals.yearly.creditMinor - data.periodTotals.yearly.debitMinor, vendor.currency, { decimals: false })}
            sub={`${data.periodTotals.yearly.count} entries · ${data.periodLabels.yearly}`}
          />
        </Link>
      </div>

      <div className="chip-scroll flex gap-2">
        <Link href={`/vendors/${vendor.id}`} className="chip" data-active={filter === "all"}>
          All
        </Link>
        <Link href={`/vendors/${vendor.id}?filter=credit`} className="chip" data-active={filter === "credit"}>
          Credit · year ({formatMinor(data.periodTotals.yearly.creditMinor, vendor.currency, { decimals: false })})
        </Link>
        <Link href={`/vendors/${vendor.id}?filter=debit`} className="chip" data-active={filter === "debit"}>
          Debit · year ({formatMinor(data.periodTotals.yearly.debitMinor, vendor.currency, { decimals: false })})
        </Link>
        <Link href={`/reports?period=monthly&vendorId=${vendor.id}`} className="chip">
          📊 Report
        </Link>
      </div>

      <div>
        <SectionTitle title="Open bills & aging" hint="FIFO settlement of payments against bills" />
        <Card>
          <div className="mb-3">
            <div className="flex items-center justify-between">
              <p className="tiny muted">Open amount</p>
              <p className="text-[15px] font-bold">
                {formatMinor(openTotal, vendor.currency)} · oldest {oldest}d
              </p>
            </div>
            <div className="mt-2">
              <Progress
                value={vendor.creditTermsDays ? (oldest / Math.max(1, vendor.creditTermsDays)) * 100 : 0}
                tone={overdue > 0 ? "debit" : "brand"}
              />
            </div>
          </div>
          {data.openLots.length === 0 ? (
            <p className="tiny muted">No open bills — everything is settled. 🎉</p>
          ) : (
            <div className="space-y-2">
              {data.openLots.slice(0, 6).map((lot) => (
                <div key={lot.transactionId} className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-semibold">
                      {lot.isOpening
                        ? "Opening balance"
                        : `Bill #${lot.transactionId}${lot.reference ? ` · ref ${lot.reference}` : ""}`}
                    </p>
                    <p className="tiny muted">
                      {fmtDate(lot.occurredAt, timeZone)} · due {lot.dueDate ? fmtDate(lot.dueDate) : "n/a"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[13px] font-bold">{formatMinor(lot.remainingMinor, lot.currency)}</p>
                    <p className={`tiny ${lot.daysOverdue > 0 ? "money-neg" : "muted"}`}>
                      {lot.daysOverdue > 0 ? `${lot.daysOverdue}d late` : `${lot.ageDays}d old`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <TransactionForm vendorId={vendor.id} currency={vendor.currency} termsDays={vendor.creditTermsDays} />

      <div>
        <SectionTitle title="Ledger entries" hint={`${data.transactions.length} entries · newest first`} />
        {data.transactions.length === 0 ? (
          <Card>
            <p className="tiny muted">No entries for this filter yet.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {data.transactions.map((t) => (
              <Card key={t.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={t.entryType === "credit" ? "credit" : "debit"}>
                        {t.entryType === "credit" ? "CR" : "DR"}
                      </Badge>
                      <p className="text-[15px] font-semibold">
                        {t.reference ? `#${t.reference}` : `Entry ${t.id}`}
                      </p>
                      {t.status !== "confirmed" ? <Badge tone="warn">{t.status}</Badge> : null}
                      {t.source === "whatsapp" ? <Badge tone="brand">WA {t.confidence}%</Badge> : null}
                    </div>
                    <p className="tiny muted mt-1">
                      {fmtDateTime(t.occurredAt, timeZone)}
                      {t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ""}
                      {t.paymentMode ? ` · ${t.paymentMode}` : ""}
                    </p>
                    {t.description ? <p className="tiny muted mt-1">{t.description}</p> : null}
                    {t.items.length ? (
                      <details className="mt-2">
                        <summary className="tiny muted">{t.items.length} item lines</summary>
                        <div className="mt-2 space-y-1">
                          {t.items.map((item) => (
                            <div key={item.id} className="flex justify-between tiny">
                              <span className="muted">
                                {item.qty}
                                {item.unit ? ` ${item.unit}` : ""} {item.name}
                              </span>
                              <span className="tabular-nums">
                                {item.lineTotalMinor ? formatMinor(item.lineTotalMinor, t.currency) : "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                    {t.messageId ? (
                      <Link href="/inbox" className="tiny tap-link text-indigo-300">
                        Open Inbox →
                      </Link>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <Money
                      minor={t.entryType === "credit" ? t.amountMinor : -t.amountMinor}
                      currency={t.currency}
                      className="text-[16px] font-bold"
                      decimals={false}
                    />
                    {t.status === "void" ? <p className="tiny muted">voided</p> : null}
                    <EntryActions transactionId={t.id} status={t.status} />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionTitle title="WhatsApp history" hint="Immutable source-of-truth messages" />
        <Card>
          {data.messages.length === 0 ? (
            <p className="tiny muted">No WhatsApp messages linked to this vendor yet.</p>
          ) : (
            <div className="space-y-3">
              {data.messages.map((m) => (
                <div key={m.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="tiny muted">
                      {m.messageType === "image" ? "🖼 image bill" : m.messageType} ·{" "}
                      {m.parseStatus} · {m.parseConfidence}% · {m.receivedAt ? timeAgo(m.receivedAt) : "—"}
                    </p>
                  </div>
                  <p className="bubble mt-1">{m.body?.slice(0, 400) ?? "[no text]"}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
