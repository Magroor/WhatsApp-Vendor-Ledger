import type { TestResult } from "./selftest";
import {
  buildPriceSeries,
  compareVendors,
  detectPriceAlerts,
  normalizeItemName,
  type PurchaseRow,
} from "./prices";

const NOW = new Date("2026-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

function row(p: Partial<PurchaseRow> & { unitPriceMinor: number; occurredAt: Date }): PurchaseRow {
  return {
    vendorId: 1,
    vendorName: "Vendor A",
    currency: "PKR",
    name: "Cement",
    unit: "bag",
    qty: 10,
    ...p,
  };
}

export function runPriceSelfTests(): TestResult[] {
  const out: TestResult[] = [];
  const suite = "prices";
  const check = (name: string, pass: boolean, detail: string) => out.push({ suite, name, pass, detail });

  const n1 = normalizeItemName("Cement");
  const n2 = normalizeItemName("cement ");
  const n3 = normalizeItemName("CEMENT.");
  check("normalize: case, trailing space, punctuation match", n1 === n2 && n2 === n3 && n1 === "cement", `${n1}|${n2}|${n3}`);
  check("normalize: collapses inner spaces", normalizeItemName("  Steel   Bar,  12mm ") === "steel bar 12mm", normalizeItemName("  Steel   Bar,  12mm "));
  const ur = normalizeItemName("سیمنٹ۔ ");
  check("normalize: keeps Urdu script", ur.startsWith("سیمنٹ") && ur.length >= 4, ur);

  const rows = [
    row({ unitPriceMinor: 160000, occurredAt: daysAgo(2) }),
    row({ unitPriceMinor: 148000, occurredAt: daysAgo(30) }),
    row({ unitPriceMinor: 150000, occurredAt: daysAgo(60), name: "cement." }),
  ];
  const series = buildPriceSeries(rows);
  check("series: groups spelling variants into one series", series.length === 1, `series=${series.length}`);
  const prices = series[0]?.points.map((p) => p.unitPriceMinor).join(",");
  check("series: ordered by date ascending", prices === "150000,148000,160000", String(prices));

  const alerts = detectPriceAlerts(series, NOW);
  check(
    "alert: 8% jump over previous flagged",
    alerts.length === 1 && alerts[0].pct === 8.1 && alerts[0].oldMinor === 148000 && alerts[0].newMinor === 160000,
    JSON.stringify(alerts.map((a) => [a.pct, a.oldMinor, a.newMinor])),
  );

  const small = buildPriceSeries([
    row({ unitPriceMinor: 100000, occurredAt: daysAgo(30) }),
    row({ unitPriceMinor: 103000, occurredAt: daysAgo(1) }),
  ]);
  check("alert: 3% rise is not flagged", detectPriceAlerts(small, NOW).length === 0, "3%");

  const exact = buildPriceSeries([
    row({ unitPriceMinor: 100000, occurredAt: daysAgo(30) }),
    row({ unitPriceMinor: 105000, occurredAt: daysAgo(1) }),
  ]);
  check("alert: exactly 5% is flagged", detectPriceAlerts(exact, NOW).length === 1, "5%");

  const avgCase = buildPriceSeries([
    row({ unitPriceMinor: 100000, occurredAt: daysAgo(60) }),
    row({ unitPriceMinor: 90000, occurredAt: daysAgo(20) }),
    row({ unitPriceMinor: 99000, occurredAt: daysAgo(1) }),
  ]);
  const avgAlerts = detectPriceAlerts(avgCase, NOW);
  check(
    "alert: 10% above previous purchase flagged",
    avgAlerts.length === 1 && avgAlerts[0].pct >= 5,
    JSON.stringify(avgAlerts.map((a) => [a.pct, a.basis])),
  );
  const avgOnly = buildPriceSeries([
    row({ unitPriceMinor: 100000, occurredAt: daysAgo(60) }),
    row({ unitPriceMinor: 120000, occurredAt: daysAgo(20) }),
    row({ unitPriceMinor: 119000, occurredAt: daysAgo(1) }),
  ]);
  const ao = detectPriceAlerts(avgOnly, NOW);
  check(
    "alert: average basis catches slow creep (previous only -0.8%, avg +8.2%)",
    ao.length === 1 && ao[0].basis === "average",
    JSON.stringify(ao.map((a) => [a.pct, a.basis])),
  );

  const one = buildPriceSeries([row({ unitPriceMinor: 100000, occurredAt: daysAgo(1) })]);
  check("alert: needs at least 2 purchases", detectPriceAlerts(one, NOW).length === 0, "single purchase");

  const units = buildPriceSeries([
    row({ unitPriceMinor: 100000, unit: "bag", occurredAt: daysAgo(10) }),
    row({ unitPriceMinor: 200000, unit: "ton", occurredAt: daysAgo(1) }),
  ]);
  check("units: kept separate (no false alert)", units.length === 2 && detectPriceAlerts(units, NOW).length === 0, `series=${units.length}`);

  const cmp = compareVendors(
    buildPriceSeries([
      row({ vendorId: 1, vendorName: "Vendor A", unitPriceMinor: 160000, occurredAt: daysAgo(3) }),
      row({ vendorId: 2, vendorName: "Vendor B", unitPriceMinor: 140000, occurredAt: daysAgo(5) }),
      row({ vendorId: 2, vendorName: "Vendor B", unitPriceMinor: 150000, occurredAt: daysAgo(40) }),
    ]),
  );
  check(
    "compare: cheapest/priciest and saving %",
    cmp.length === 1 &&
      cmp[0].cheapest.vendorName === "Vendor B" &&
      cmp[0].priciest.vendorName === "Vendor A" &&
      cmp[0].savingPct === 12.5,
    JSON.stringify(cmp.map((c) => [c.cheapest.vendorName, c.savingPct])),
  );
  check("compare: uses each vendor's latest price", cmp[0]?.vendors.find((v) => v.vendorId === 2)?.unitPriceMinor === 140000, "latest");

  return out;
}
