import Link from "next/link";
import PriceTrend from "@/components/PriceTrend";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import { getItemDetail, getPriceOverview, type ItemSummary } from "@/lib/prices";
import { fmtDate } from "@/lib/time";

export const dynamic = "force-dynamic";

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <Badge>new</Badge>;
  if (pct === 0) return <Badge>no change</Badge>;
  return (
    <Badge tone={pct > 0 ? "debit" : "credit"}>
      {pct > 0 ? "▲" : "▼"} {Math.abs(pct)}%
    </Badge>
  );
}

function unitLabel(unit: string | null) {
  return unit ? ` / ${unit}` : "";
}

function itemHref(i: Pick<ItemSummary, "normName">) {
  return `/prices?item=${encodeURIComponent(i.normName)}`;
}

export default async function PricesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; item?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const itemParam = (params.item ?? "").trim();

  const header = (
    <div>
      <h1 className="h1">Item prices</h1>
      <p className="tiny muted mt-1">
        Track what you pay for each item, compare vendors and get warned when prices jump.
      </p>
    </div>
  );

  /* ------------------------- detail view ------------------------- */
  if (itemParam) {
    const detail = await getItemDetail(itemParam);
    return (
      <div className="space-y-5 rise">
        {header}
        <Link href="/prices" className="btn btn-sm">
          ← All items
        </Link>
        {!detail ? (
          <EmptyState
            icon="🔎"
            title="No purchases found"
            hint="There are no confirmed bills with a unit price for this item."
          />
        ) : (
          <>
            <h2 className="h1 break-words">{detail.name}</h2>
            {detail.units.map((u) => (
              <section key={u.unit ?? "none"} className="space-y-3">
                <SectionTitle
                  title={`Unit price${unitLabel(u.unit)}`}
                  hint={`${u.purchases.length} purchase${u.purchases.length === 1 ? "" : "s"}`}
                />
                <Card>
                  <PriceTrend
                    title={`Unit price trend for ${detail.name}${unitLabel(u.unit)}`}
                    currency={u.currency}
                    series={u.series.map((s) => ({
                      label: s.vendorName,
                      points: s.points.map((p) => ({ t: p.date.getTime(), v: p.unitPriceMinor })),
                    }))}
                  />
                </Card>

                <Card>
                  <p className="label">Purchases</p>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                      <thead>
                        <tr className="tiny muted">
                          <th className="py-1 pr-2 font-semibold">Date</th>
                          <th className="py-1 pr-2 font-semibold">Vendor</th>
                          <th className="py-1 pr-2 text-right font-semibold">Qty</th>
                          <th className="py-1 text-right font-semibold">Unit price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {u.purchases.map((p, i) => (
                          <tr key={i} className="border-t border-white/10">
                            <td className="py-2 pr-2 whitespace-nowrap">{fmtDate(p.occurredAt)}</td>
                            <td className="max-w-[110px] truncate py-2 pr-2">{p.vendorName}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{p.qty}</td>
                            <td className="py-2 text-right tabular-nums whitespace-nowrap">
                              {formatMinor(p.unitPriceMinor, p.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {u.comparison && u.comparison.vendors.length > 0 ? (
                  <Card>
                    <div className="flex items-center justify-between gap-2">
                      <p className="label">Vendor comparison</p>
                      {u.comparison.vendors.length > 1 ? (
                        <Badge tone="credit">save up to {u.comparison.savingPct}%</Badge>
                      ) : null}
                    </div>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-left text-[13px]">
                        <thead>
                          <tr className="tiny muted">
                            <th className="py-1 pr-2 font-semibold">Vendor</th>
                            <th className="py-1 pr-2 text-right font-semibold">Latest</th>
                            <th className="py-1 text-right font-semibold">As of</th>
                          </tr>
                        </thead>
                        <tbody>
                          {u.comparison.vendors.map((v, i) => (
                            <tr key={v.vendorId} className="border-t border-white/10">
                              <td className="max-w-[130px] py-2 pr-2">
                                <span className="block truncate">{v.vendorName}</span>
                                {u.comparison!.vendors.length > 1 && i === 0 ? (
                                  <span className="tiny text-emerald-300">cheapest</span>
                                ) : null}
                                {u.comparison!.vendors.length > 1 &&
                                i === u.comparison!.vendors.length - 1 ? (
                                  <span className="tiny text-rose-300">most expensive</span>
                                ) : null}
                              </td>
                              <td className="py-2 pr-2 text-right tabular-nums whitespace-nowrap">
                                {formatMinor(v.unitPriceMinor, u.currency)}
                              </td>
                              <td className="py-2 text-right whitespace-nowrap tiny muted">
                                {fmtDate(v.date)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                ) : null}
              </section>
            ))}
          </>
        )}
      </div>
    );
  }

  /* ------------------------- overview ------------------------- */
  const overview = await getPriceOverview(q);

  return (
    <div className="space-y-5 rise">
      {header}

      <form className="card flex gap-2" action="/prices" method="get">
        <label htmlFor="price-q" className="sr-only">
          Search items
        </label>
        <input
          id="price-q"
          className="field"
          name="q"
          defaultValue={q}
          placeholder="Search items (e.g. cement)"
          autoComplete="off"
        />
        <button className="btn btn-sm" type="submit" aria-label="Search">
          🔍
        </button>
      </form>

      {overview.totalItems === 0 ? (
        <EmptyState
          icon="📈"
          title="No price history yet"
          hint="Prices appear automatically from bills that list items with unit prices. Confirm a few bills and they will show up here."
        />
      ) : (
        <>
          <div>
            <SectionTitle title="Price changes" hint="Latest price is 5%+ above the previous or recent average" />
            {overview.alerts.length === 0 ? (
              <EmptyState icon="✅" title="No price jumps" hint="Nothing has gone up by 5% or more recently." />
            ) : (
              <div className="space-y-2">
                {overview.alerts.map((a) => (
                  <Link key={a.key} href={itemHref(a)} className="block">
                    <Card press>
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 break-words text-[15px] font-semibold">
                          {a.name}
                          <span className="muted font-normal">{unitLabel(a.unit)}</span>
                        </p>
                        <Badge tone="warn">▲ {a.pct}%</Badge>
                      </div>
                      <p className="tiny muted mt-0.5">{a.vendorName}</p>
                      <p className="mt-1 text-[13px]">
                        up {a.pct}% since {fmtDate(a.since)}: {formatMinor(a.oldMinor, a.currency)} →{" "}
                        {formatMinor(a.newMinor, a.currency)}
                        {a.basis === "average" ? <span className="tiny muted"> (vs recent average)</span> : null}
                      </p>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div>
            <SectionTitle
              title="Items"
              hint={q ? `${overview.items.length} match “${q}”` : `${overview.items.length} tracked`}
            />
            {overview.items.length === 0 ? (
              <EmptyState icon="🔎" title="No matching items" hint="Try a shorter search." />
            ) : (
              <div className="space-y-2">
                {overview.items.map((i) => (
                  <Link key={`${i.normName}|${i.unit ?? ""}`} href={itemHref(i)} className="block">
                    <Card press>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-semibold">
                            {i.name}
                            <span className="muted font-normal">{unitLabel(i.unit)}</span>
                          </p>
                          <p className="tiny muted">
                            {i.purchases} purchase{i.purchases === 1 ? "" : "s"} · {i.vendorCount} vendor
                            {i.vendorCount === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[15px] font-bold tabular-nums">{formatMinor(i.latestMinor, i.currency)}</p>
                          <ChangeBadge pct={i.changePct} />
                        </div>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
