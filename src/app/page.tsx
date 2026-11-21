import Link from "next/link";
import PayThisWeek from "@/components/PayThisWeek";
import ScanBill from "@/components/ScanBill";
import { getPayPlan } from "@/lib/planner";
import { Badge, Card, EmptyState, Money, SectionTitle, StatTile } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import { getDashboard } from "@/lib/queries";
import { fmtDateTime, timeAgo } from "@/lib/time";
import { whatsappConfigured } from "@/lib/wa";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [data, payPlan] = await Promise.all([getDashboard(), getPayPlan()]);
  const live = whatsappConfigured();
  const pending = data.stats.pendingMessages;
  const maxBalance = Math.max(
    1,
    ...data.topVendors.map((v) => Math.abs(v.balanceMinor)),
  );

  return (
    <div className="space-y-5 rise">
      <ScanBill vendors={data.stats.vendors.map((v) => ({ id: v.id, name: v.name }))} />
      <Link href="/import" className="card card-press block text-center">
        <span className="h2">📥 Catch up on old months</span>
        <span className="tiny muted mt-1 block">Import a whole WhatsApp chat (Export Chat) for past bills</span>
      </Link>

      <Card className="border-indigo-400/30 bg-indigo-500/10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="tiny muted font-semibold uppercase tracking-wide">Business</p>
            <p className="h2 mt-1">{data.settings.businessName}</p>
            <p className="tiny muted mt-1">
              {data.stats.vendors.length} vendors · {data.stats.auditCount} audit events
            </p>
          </div>
          <Badge tone={live ? "credit" : "warn"}>
            {live ? "WhatsApp live" : "Sandbox mode"}
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatTile
            label="You owe (payable)"
            value={formatMinor(data.payableMinor, data.settings.currency)}
            tone="debit"
          />
          <StatTile
            label="Owed to you (receivable)"
            value={formatMinor(data.receivableMinor, data.settings.currency)}
            tone="credit"
            sub={
              data.vendorAdvanceMinor > 0
                ? `+ ${formatMinor(data.vendorAdvanceMinor, data.settings.currency)} vendor advances`
                : "from customers"
            }
          />
        </div>
      </Card>

      {data.customerCount > 0 ? (
        <div>
          <SectionTitle
            title="Customers who owe you"
            hint="Largest receivables"
            action={
              <Link href="/vendors?kind=customer" className="pill pill-brand">
                All →
              </Link>
            }
          />
          <Card>
            <div className="space-y-3">
              {data.topCustomers.length === 0 ? (
                <p className="tiny muted">No customer owes you right now.</p>
              ) : (
                data.topCustomers.map((c) => (
                  <Link key={c.id} href={`/vendors/${c.id}`} className="flex min-h-10 items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[15px] font-semibold">{c.name}</span>
                    <span className="money-pos text-[15px] font-bold">{formatMinor(c.balanceMinor, c.currency)}</span>
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>
      ) : null}

      {payPlan.vendors.length > 0 ? <PayThisWeek plan={payPlan} /> : null}

      <div>
        <SectionTitle
          title="This week"
          hint={data.week.label}
          action={
            <Link href="/reports?period=weekly" className="pill pill-brand">
              Report →
            </Link>
          }
        />
        <div className="grid grid-cols-3 gap-2">
          <StatTile
            label="Credit"
            value={formatMinor(data.week.creditMinor, data.settings.currency)}
            tone="credit"
            sub={`${data.week.creditMinor ? "billed" : "no bills"}`}
          />
          <StatTile
            label="Debit"
            value={formatMinor(data.week.debitMinor, data.settings.currency)}
            tone="debit"
            sub="payments"
          />
          <StatTile
            label="Net"
            value={formatMinor(data.week.netMinor, data.settings.currency)}
            sub="balance moved"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Link href="/inbox" className="btn btn-primary">
          💬 Inbox
        </Link>
        <Link href="/vendors?add=1" className="btn">
          👤 Add vendor
        </Link>
        <Link href="/vendors?tab=due" className="btn">
          🔔 Reminders
        </Link>
        <Link href="/reports?period=monthly" className="btn">
          📊 Monthly report
        </Link>
        <Link href="/prices" className="btn">
          💰 Item prices
        </Link>
        <Link href="/review" className="btn">
          ✅ Review queue
        </Link>
      </div>

      <Card className={pending ? "border-amber-400/40 bg-amber-400/10" : ""}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="h2">{pending} messages need review</p>
            <p className="tiny muted mt-1">
              Bills the parser could not fully resolve (missing amount or direction).
            </p>
          </div>
          <Link href="/inbox?status=pending" className={`btn btn-sm ${pending ? "btn-debit" : ""}`}>
            Review
          </Link>
        </div>
      </Card>

      <div>
        <SectionTitle title="Top vendor balances" hint="Largest open khata positions" />
        <Card>
          <div className="space-y-3">
            {data.topVendors.length === 0 ? (
              <EmptyState
                icon="👥"
                title="No vendors yet"
                hint="Add a vendor or seed demo data from Settings to see the automation in action."
                action={
                  <Link href="/settings" className="btn btn-sm btn-primary">
                    Seed demo data
                  </Link>
                }
              />
            ) : (
              data.topVendors.map((v) => (
                <Link key={v.id} href={`/vendors/${v.id}`} className="block card-press">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold">{v.name}</p>
                      <p className="tiny muted">
                        {v.count} entries · terms Net-{v.creditTermsDays}
                      </p>
                    </div>
                    <Money minor={v.balanceMinor} currency={v.currency} className="text-[15px] font-bold" />
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.max(3, (Math.abs(v.balanceMinor) / maxBalance) * 100)}%`,
                        background: v.balanceMinor >= 0 ? "linear-gradient(90deg,#818cf8,#c084fc)" : "linear-gradient(90deg,#6ee7b7,#10b981)",
                      }}
                    />
                  </div>
                </Link>
              ))
            )}
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle title="Recent ledger activity" hint="Auto-posted from WhatsApp + manual" />
        <Card>
          <div className="space-y-3">
            {data.recent.length === 0 ? (
              <p className="tiny muted">No entries yet.</p>
            ) : (
              data.recent.map((t) => (
                <div key={t.id} className="flex items-start gap-3">
                  <Badge tone={t.entryType === "credit" ? "credit" : "debit"}>
                    {t.entryType === "credit" ? "CR" : "DR"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">{t.vendorName}</p>
                    <p className="tiny muted truncate">
                      {t.reference ? `#${t.reference} · ` : ""}
                      {t.source === "whatsapp" ? `WhatsApp · ${t.confidence}%` : "manual"} ·{" "}
                      {fmtDateTime(t.occurredAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <Money minor={t.entryType === "credit" ? t.amountMinor : -t.amountMinor} currency={t.currency} className="text-[14px] font-bold" />
                    {t.status === "draft" ? (
                      <p className="tiny pill-warn mt-1 rounded-full px-2">draft</p>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle
          title="WhatsApp feed"
          hint={data.stats.lastMessageAt ? `Last message ${timeAgo(data.stats.lastMessageAt)}` : "No messages yet"}
          action={
            <Link href="/inbox" className="pill">
              Open inbox →
            </Link>
          }
        />
        <Card>
          <div className="space-y-3">
            {data.inbox.length === 0 ? (
              <p className="tiny muted">
                Nothing yet. Use <b>Add a bill</b> above: a photo, a chat screenshot, or pasted text.
              </p>
            ) : (
              data.inbox.map((m) => (
                <div key={m.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-semibold">
                      {m.vendorName ?? m.profileName ?? "Unknown"}
                    </p>
                    <span className="tiny muted">{timeAgo(m.receivedAt)}</span>
                  </div>
                  <p className="tiny muted line-clamp-2 mt-0.5">
                    {m.body?.slice(0, 120) ?? `[${m.messageType}]`}
                  </p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card className="border-white/5">
        <SectionTitle title="Automation status" hint="How WhatsApp becomes a ledger" />
        <ul className="tiny muted space-y-1.5">
          <li>✅ Inbound webhook stores every message before parsing (no data loss).</li>
          <li>✅ Rules engine + OCR/LLM extraction of amount, items, ref and direction.</li>
          <li>✅ High-confidence entries auto-post; low-confidence go to review.</li>
          <li>✅ Auto WhatsApp confirmation reply with running balance.</li>
          <li>✅ Weekly / monthly / yearly reports, aging + CSV & PDF export.</li>
        </ul>
      </Card>
    </div>
  );
}
