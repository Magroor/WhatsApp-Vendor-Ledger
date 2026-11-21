import Link from "next/link";
import ReminderButton from "@/components/ReminderButton";
import VendorForm from "@/components/VendorForm";
import { Avatar, Badge, Card, EmptyState, Money, SectionTitle, StatTile } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import { getVendorsList } from "@/lib/queries";
import { labelsFor, normalizeKind } from "@/lib/kind";
import { timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string; tab?: string; q?: string; kind?: string }>;
}) {
  const params = await searchParams;
  const kind = normalizeKind(params.kind);
  const L = labelsFor(kind);
  const isCustomer = kind === "customer";
  const base = isCustomer ? "/vendors?kind=customer" : "/vendors";
  const withParam = (p: string) => (isCustomer ? `${base}&${p}` : `${base}?${p}`);
  const data = await getVendorsList(params.q, kind);
  const showDue = params.tab === "due";
  const dueList = data.vendors.filter((v) => v.overdueDays > 0);

  return (
    <div className="space-y-5 rise">
      <nav className="grid grid-cols-2 gap-2" aria-label="Vendors or customers">
        <Link href="/vendors" className="chip justify-center" data-active={!isCustomer} aria-current={!isCustomer ? "page" : undefined}>
          Vendors
        </Link>
        <Link
          href="/vendors?kind=customer"
          className="chip justify-center"
          data-active={isCustomer}
          aria-current={isCustomer ? "page" : undefined}
        >
          Customers
        </Link>
      </nav>

      <div className="grid grid-cols-3 gap-2">
        {isCustomer ? (
          <>
            <StatTile label="They owe you" value={formatMinor(data.totals.payable, data.settings.currency)} tone="credit" />
            <StatTile label="Advances" value={formatMinor(data.totals.receivable, data.settings.currency)} tone="debit" />
          </>
        ) : (
          <>
            <StatTile label="Payable" value={formatMinor(data.totals.payable, data.settings.currency)} tone="debit" />
            <StatTile label="Receivable" value={formatMinor(data.totals.receivable, data.settings.currency)} tone="credit" />
          </>
        )}
        <StatTile label="Overdue" value={formatMinor(data.totals.overdue, data.settings.currency)} tone="brand" />
      </div>

      <VendorForm key={kind} open={params.add === "1"} kind={kind} />

      <form className="card flex gap-2" action="/vendors">
        {isCustomer ? <input type="hidden" name="kind" value="customer" /> : null}
        <label className="sr-only" htmlFor="party-search">
          Search {L.nounPlural.toLowerCase()}
        </label>
        <input
          id="party-search"
          className="field"
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Search name or WhatsApp number"
          autoComplete="off"
        />
        <button className="btn btn-sm" type="submit" aria-label="Search">
          🔍
        </button>
      </form>

      <div className="flex gap-2">
        <Link href={base} className="chip" data-active={!showDue}>
          All ({data.vendors.length})
        </Link>
        <Link href={withParam("tab=due")} className="chip" data-active={showDue}>
          Overdue ({dueList.length})
        </Link>
      </div>

      {showDue ? (
        <div>
          <SectionTitle
            title="Payment reminders"
            hint={
              isCustomer
                ? "Credit sales past their terms — one tap WhatsApp payment request"
                : "Open bills past their credit terms — one tap WhatsApp nudge"
            }
          />
          {dueList.length === 0 ? (
            <EmptyState icon="✅" title="Nothing overdue" hint={`Every ${L.nounLower} is inside their credit terms.`} />
          ) : (
            <Card>
              <div className="space-y-4">
                {dueList.map((v) => (
                  <div key={v.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/vendors/${v.id}`} className="text-[15px] font-semibold">
                        {v.name}
                      </Link>
                      <p className="tiny muted">
                        {v.openAmountMinor > 0
                          ? `${formatMinor(v.openAmountMinor, v.currency)} open · ${v.overdueDays}d overdue`
                          : "No open bills"}
                      </p>
                    </div>
                    <ReminderButton vendorId={v.id} vendorName={v.name} kind={kind} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      ) : null}

      <div>
        <SectionTitle
          title={`${L.noun} ledgers`}
          hint={`Every ${L.nounLower} has an isolated credit/debit khata`}
        />
        {data.vendors.length === 0 ? (
          <EmptyState
            icon="👥"
            title={`No ${L.nounPlural.toLowerCase()} found`}
            hint={
              isCustomer
                ? "Add a customer who buys on credit (udhaar) to track what they owe you."
                : "Add a vendor manually, or let WhatsApp auto-create one the first time a bill arrives."
            }
          />
        ) : (
          <div className="space-y-2">
            {data.vendors.map((v) => (
              <Link key={v.id} href={`/vendors/${v.id}`} className="block">
                <Card press>
                  <div className="flex items-center gap-3">
                    <Avatar name={v.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[15px] font-semibold">{v.name}</p>
                        {v.needsReview ? <Badge tone="warn">review</Badge> : null}
                        {v.pendingMessages > 0 ? <Badge tone="brand">{v.pendingMessages} to review</Badge> : null}
                      </div>
                      <p className="tiny muted truncate">
                        {v.phone ?? "no number"} · Net-{v.creditTermsDays}
                        {v.lastActivity ? ` · last ${timeAgo(v.lastActivity)}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <Money minor={v.balanceMinor} currency={v.currency} className="text-[15px] font-bold" />
                      <p className="tiny muted">
                        CR {formatMinor(v.creditMinor, v.currency, { decimals: false })}
                      </p>
                    </div>
                  </div>
                  {v.overdueDays > 0 ? (
                    <p className="tiny mt-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-rose-200">
                      ⚠︎ {formatMinor(v.openAmountMinor, v.currency)} overdue by {v.overdueDays} days
                    </p>
                  ) : null}
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
