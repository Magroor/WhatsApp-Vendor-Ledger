/**
 * Report / period / aging / CSV checks. Pure (no DB access) and independent
 * of the server's own timezone: every check passes an explicit business
 * timezone and asserts on UTC instants.
 */
import {
  agingBuckets,
  buildSeries,
  computeOpenLots,
  csvAmount,
  csvText,
  parseAnchor,
  periodNavigation,
  periodRange,
  reportToCsv,
  summarize,
  type LedgerRow,
  type OpenLot,
  type ReportPayload,
} from "./reports";
import type { TestResult } from "./selftest";
import { fmtDate, isoWeekKey, resolveTimeZone } from "./time";

const PKT = "Asia/Karachi";

function row(p: Partial<LedgerRow> & { id: number; entryType: "credit" | "debit"; amountMinor: number; occurredAt: Date }): LedgerRow {
  return {
    vendorId: 1,
    vendorName: "Test Vendor",
    vendorPhone: null,
    currency: "PKR",
    taxMinor: 0,
    dueDate: null,
    status: "confirmed",
    source: "whatsapp",
    reference: null,
    description: null,
    confidence: 90,
    messageId: null,
    ...p,
  };
}

const iso = (d: Date) => d.toISOString();
const remaining = (lots: OpenLot[], vendorId?: number) =>
  lots.filter((l) => vendorId === undefined || l.vendorId === vendorId).reduce((a, l) => a + l.remainingMinor, 0);

export function runReportSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ suite: "reports-tz", name, pass, detail });
  const safe = (name: string, fn: () => [boolean, string]) => {
    try {
      const [pass, detail] = fn();
      check(name, pass, detail);
    } catch (err) {
      check(name, false, `threw: ${(err as Error).message}`);
    }
  };

  // ---- period edges in business tz (server tz irrelevant)
  safe("weekly edges = Monday 00:00 PKT", () => {
    const w = periodRange("weekly", new Date("2026-02-18T12:00:00Z"), PKT);
    return [
      iso(w.start) === "2026-02-15T19:00:00.000Z" &&
        iso(w.endExclusive) === "2026-02-22T19:00:00.000Z" &&
        iso(w.end) === "2026-02-22T18:59:59.999Z" &&
        w.key === "2026-W08",
      `${iso(w.start)} → ${iso(w.end)} ${w.key}`,
    ];
  });
  safe("Sunday 23:30 PKT stays in previous week", () => {
    const w = periodRange("weekly", new Date("2026-02-15T18:30:00Z"), PKT);
    return [w.key === "2026-W07" && iso(w.start) === "2026-02-08T19:00:00.000Z", `${w.key} ${iso(w.start)}`];
  });
  safe("UTC-evening instant belongs to next PKT month", () => {
    const m = periodRange("monthly", new Date("2026-02-28T20:00:00Z"), PKT);
    return [m.key === "2026-03" && iso(m.start) === "2026-02-28T19:00:00.000Z" && m.days === 31, `${m.key} ${iso(m.start)} days=${m.days}`];
  });
  safe("UTC-evening Dec 31 belongs to next PKT year", () => {
    const y = periodRange("yearly", new Date("2025-12-31T20:00:00Z"), PKT);
    return [y.key === "2026" && iso(y.start) === "2025-12-31T19:00:00.000Z" && y.days === 365, `${y.key} ${iso(y.start)}`];
  });
  safe("previous period edges", () => {
    const m = periodRange("monthly", new Date("2026-03-10T12:00:00Z"), PKT);
    return [
      iso(m.previousStart) === "2026-01-31T19:00:00.000Z" && iso(m.previousEnd) === "2026-02-28T18:59:59.999Z",
      `${iso(m.previousStart)} → ${iso(m.previousEnd)}`,
    ];
  });

  // ---- ISO week numbering (week-year = year of Thursday)
  const weekCases: Array<[string, string]> = [
    ["2025-12-29", "2026-W01"],
    ["2027-01-01", "2026-W53"],
    ["2021-01-03", "2020-W53"],
    ["2024-12-30", "2025-W01"],
    ["2026-01-01", "2026-W01"],
    ["2026-12-31", "2026-W53"],
  ];
  for (const [day, expected] of weekCases) {
    safe(`ISO week ${day}`, () => {
      const [y, m, d] = day.split("-").map(Number);
      const got = isoWeekKey({ y, m, d });
      return [got === expected, got];
    });
  }

  // ---- DST safety
  safe("DST week (New York, spring forward) has correct edges", () => {
    const w = periodRange("weekly", new Date("2026-03-05T12:00:00Z"), "America/New_York");
    return [
      iso(w.start) === "2026-03-02T05:00:00.000Z" && iso(w.endExclusive) === "2026-03-09T04:00:00.000Z" && w.days === 7,
      `${iso(w.start)} → ${iso(w.endExclusive)} days=${w.days}`,
    ];
  });
  safe("DST week series buckets late Sunday into day 7", () => {
    const w = periodRange("weekly", new Date("2026-03-05T12:00:00Z"), "America/New_York");
    const s = buildSeries(
      [row({ id: 1, entryType: "credit", amountMinor: 100, occurredAt: new Date("2026-03-09T03:30:00Z") })],
      "weekly",
      w,
    );
    return [s.length === 7 && s[6].creditMinor === 100 && s[6].label === "8/3", JSON.stringify(s.map((p) => p.creditMinor))];
  });
  safe("DST month (London, fall back) has correct edges", () => {
    const m = periodRange("monthly", new Date("2026-10-15T12:00:00Z"), "Europe/London");
    return [
      iso(m.start) === "2026-09-30T23:00:00.000Z" && iso(m.endExclusive) === "2026-11-01T00:00:00.000Z" && m.days === 31,
      `${iso(m.start)} → ${iso(m.endExclusive)}`,
    ];
  });

  // ---- series bucketing in PKT
  safe("weekly series buckets by PKT day", () => {
    const w = periodRange("weekly", new Date("2026-02-18T12:00:00Z"), PKT);
    const s = buildSeries(
      [
        row({ id: 1, entryType: "credit", amountMinor: 100, occurredAt: new Date("2026-02-15T19:30:00Z") }), // Mon 00:30 PKT
        row({ id: 2, entryType: "debit", amountMinor: 40, occurredAt: new Date("2026-02-15T18:30:00Z") }), // prev Sun
        row({ id: 3, entryType: "debit", amountMinor: 70, occurredAt: new Date("2026-02-22T18:00:00Z") }), // Sun 23:00 PKT
      ],
      "weekly",
      w,
    );
    return [
      s[0].creditMinor === 100 && s[0].debitMinor === 0 && s[6].debitMinor === 70 && s[0].label === "16/2",
      JSON.stringify(s),
    ];
  });
  safe("monthly series length = days in month", () => {
    const m = periodRange("monthly", new Date("2026-02-10T12:00:00Z"), PKT);
    return [buildSeries([], "monthly", m).length === 28, String(buildSeries([], "monthly", m).length)];
  });
  safe("yearly series buckets by PKT month", () => {
    const y = periodRange("yearly", new Date("2026-06-01T00:00:00Z"), PKT);
    const s = buildSeries(
      [row({ id: 1, entryType: "credit", amountMinor: 5, occurredAt: new Date("2026-01-31T20:00:00Z") })], // Feb 1 PKT
      "yearly",
      y,
    );
    return [s[1].creditMinor === 5 && s[0].creditMinor === 0, `${s[0].creditMinor}/${s[1].creditMinor}`];
  });

  // ---- navigation / anchors
  safe("next period from Jan 31 lands in February", () => {
    const jan = periodRange("monthly", new Date("2026-01-31T10:00:00Z"), PKT);
    const next = periodRange("monthly", new Date(periodNavigation(jan).next), PKT);
    const prev = periodRange("monthly", new Date(periodNavigation(jan).previous), PKT);
    return [next.key === "2026-02" && prev.key === "2025-12", `${prev.key} < ${jan.key} > ${next.key}`];
  });
  safe("date-only anchor is a PKT calendar date", () => {
    const a = parseAnchor("2026-03-01", PKT);
    const m = a ? periodRange("monthly", a, PKT) : null;
    return [m?.key === "2026-03", String(m?.key)];
  });
  safe("invalid anchor rejected", () => [parseAnchor("not-a-date", PKT) === null, "null"]);
  safe("invalid timezone falls back", () => {
    const tz = resolveTimeZone("Not/AZone");
    return [tz !== "Not/AZone" && tz.length > 0, tz];
  });
  safe("fmtDate uses business tz; date-only not shifted", () => {
    const a = fmtDate(new Date("2026-02-17T20:00:00Z"), PKT);
    const b = fmtDate("2026-02-18", "America/Los_Angeles");
    return [a === "18 Feb 2026" && b === "18 Feb 2026", `${a} | ${b}`];
  });

  // ---- FIFO lots
  safe("FIFO is per vendor", () => {
    const lots = computeOpenLots(
      [
        row({ id: 1, vendorId: 1, entryType: "credit", amountMinor: 1000, occurredAt: new Date("2026-01-01T06:00:00Z") }),
        row({ id: 2, vendorId: 2, entryType: "debit", amountMinor: 500, occurredAt: new Date("2026-01-02T06:00:00Z") }),
      ],
      new Date("2026-01-10T06:00:00Z"),
      { timeZone: PKT },
    );
    return [remaining(lots, 1) === 1000 && remaining(lots, 2) === 0, `v1=${remaining(lots, 1)} v2=${remaining(lots, 2)}`];
  });
  safe("advance payment carries forward to later bill", () => {
    const lots = computeOpenLots(
      [
        row({ id: 1, entryType: "debit", amountMinor: 300, occurredAt: new Date("2026-01-01T06:00:00Z") }),
        row({ id: 2, entryType: "credit", amountMinor: 1000, occurredAt: new Date("2026-01-02T06:00:00Z") }),
      ],
      new Date("2026-01-10T06:00:00Z"),
      { timeZone: PKT },
    );
    return [remaining(lots) === 700, String(remaining(lots))];
  });
  safe("opening balance is the oldest lot", () => {
    const rows = [
      row({ id: 1, entryType: "credit", amountMinor: 1000, occurredAt: new Date("2026-01-02T06:00:00Z") }),
      row({ id: 2, entryType: "debit", amountMinor: 600, occurredAt: new Date("2026-01-03T06:00:00Z") }),
    ];
    const lots = computeOpenLots(rows, new Date("2026-01-10T06:00:00Z"), {
      timeZone: PKT,
      openings: [{ vendorId: 1, vendorName: "Test Vendor", currency: "PKR", amountMinor: 500, asOf: new Date("2026-01-01T00:00:00Z") }],
    });
    const opening = lots.find((l) => l.isOpening);
    const bill = lots.find((l) => l.transactionId === 1);
    return [
      !opening && bill?.remainingMinor === 900 && remaining(lots) === 500 + 1000 - 600,
      `opening=${opening?.remainingMinor ?? 0} bill=${bill?.remainingMinor}`,
    ];
  });
  safe("negative opening balance acts as advance", () => {
    const lots = computeOpenLots(
      [row({ id: 1, entryType: "credit", amountMinor: 1000, occurredAt: new Date("2026-01-02T06:00:00Z") })],
      new Date("2026-01-10T06:00:00Z"),
      { timeZone: PKT, openings: [{ vendorId: 1, vendorName: "V", currency: "PKR", amountMinor: -200, asOf: new Date("2026-01-01T00:00:00Z") }] },
    );
    return [remaining(lots) === 800, String(remaining(lots))];
  });
  safe("open lots invariant: Σ remaining = max(0, opening + credit − debit)", () => {
    const rows: LedgerRow[] = [];
    let id = 1;
    const amounts = [700, -200, 300, -900, 1200, -50, -1500, 400];
    for (const vendorId of [1, 2]) {
      amounts.forEach((a, i) => {
        rows.push(
          row({
            id: id++,
            vendorId,
            entryType: a > 0 ? "credit" : "debit",
            amountMinor: Math.abs(a) * vendorId,
            occurredAt: new Date(Date.UTC(2026, 0, 1 + i, 8)),
          }),
        );
      });
    }
    const openings = [
      { vendorId: 1, vendorName: "A", currency: "PKR", amountMinor: 250, asOf: new Date("2025-12-01T00:00:00Z") },
      { vendorId: 2, vendorName: "B", currency: "PKR", amountMinor: -100, asOf: new Date("2025-12-01T00:00:00Z") },
    ];
    const lots = computeOpenLots(rows, new Date("2026-02-01T00:00:00Z"), { openings, timeZone: PKT });
    const ok = [1, 2].every((v) => {
      const net =
        (openings.find((o) => o.vendorId === v)?.amountMinor ?? 0) +
        rows.filter((r) => r.vendorId === v).reduce((a, r) => a + (r.entryType === "credit" ? r.amountMinor : -r.amountMinor), 0);
      return remaining(lots, v) === Math.max(0, net);
    });
    return [ok, `v1=${remaining(lots, 1)} v2=${remaining(lots, 2)}`];
  });
  safe("draft / void rows excluded from lots and totals", () => {
    const rows = [
      row({ id: 1, entryType: "credit", amountMinor: 1000, occurredAt: new Date("2026-01-02T06:00:00Z") }),
      row({ id: 2, entryType: "credit", amountMinor: 999, status: "draft", occurredAt: new Date("2026-01-02T06:00:00Z") }),
      row({ id: 3, entryType: "debit", amountMinor: 999, status: "void", occurredAt: new Date("2026-01-03T06:00:00Z") }),
    ];
    const s = summarize(rows);
    const lots = computeOpenLots(rows, new Date("2026-01-10T06:00:00Z"), { timeZone: PKT });
    return [s.creditMinor === 1000 && s.debitMinor === 0 && s.creditCount === 1 && remaining(lots) === 1000, `${s.creditMinor}/${s.debitMinor}/${remaining(lots)}`];
  });

  // ---- aging / overdue in business-tz calendar days
  safe("daysOverdue counts PKT calendar days after due date", () => {
    const lots = computeOpenLots(
      [row({ id: 1, entryType: "credit", amountMinor: 100, dueDate: "2026-02-10", occurredAt: new Date("2026-02-10T18:30:00Z") })],
      new Date("2026-02-10T19:30:00Z"), // Feb 11 00:30 PKT
      { timeZone: PKT },
    );
    return [lots[0]?.daysOverdue === 1 && lots[0]?.ageDays === 1, `overdue=${lots[0]?.daysOverdue} age=${lots[0]?.ageDays}`];
  });
  safe("not overdue on the due date itself", () => {
    const lots = computeOpenLots(
      [row({ id: 1, entryType: "credit", amountMinor: 100, dueDate: "2026-02-10", occurredAt: new Date("2026-02-01T06:00:00Z") })],
      new Date("2026-02-10T18:00:00Z"), // Feb 10 23:00 PKT
      { timeZone: PKT },
    );
    return [lots[0]?.daysOverdue === 0, String(lots[0]?.daysOverdue)];
  });
  safe("aging bucket boundaries 30/31 by bill age", () => {
    const now = new Date("2026-03-31T06:00:00Z");
    const lots = computeOpenLots(
      [
        row({ id: 1, entryType: "credit", amountMinor: 10, occurredAt: new Date("2026-03-01T06:00:00Z") }), // 30d
        row({ id: 2, entryType: "credit", amountMinor: 20, occurredAt: new Date("2026-02-28T06:00:00Z") }), // 31d
      ],
      now,
      { timeZone: PKT },
    );
    const b = agingBuckets(lots);
    return [b[0].amountMinor === 10 && b[1].amountMinor === 20, b.map((x) => x.amountMinor).join(",")];
  });

  // ---- CSV
  safe("csv neutralises formula injection", () => {
    const cells = [csvText("=HYPERLINK(\"x\")"), csvText("+1"), csvText("-cmd"), csvText("@SUM(A1)"), csvText("a,b")];
    return [
      cells[0] === `"'=HYPERLINK(""x"")"` && cells[1] === "'+1" && cells[2] === "'-cmd" && cells[3] === "'@SUM(A1)" && cells[4] === '"a,b"',
      cells.join(" | "),
    ];
  });
  safe("csv amounts exact major units, negatives stay numeric", () => {
    const vals = [csvAmount(1500050), csvAmount(-5), csvAmount(0), csvAmount(-123456)];
    return [vals.join("|") === "15000.50|-0.05|0.00|-1234.56", vals.join("|")];
  });
  safe("csv has entries, order items, running balance; no injection", () => {
    const m = periodRange("monthly", new Date("2026-02-10T12:00:00Z"), PKT);
    const entries = [
      row({ id: 11, entryType: "credit", amountMinor: 150000, reference: "=1+1", description: "@evil", occurredAt: new Date("2026-02-02T06:00:00Z") }),
      row({ id: 12, entryType: "debit", amountMinor: 50000, occurredAt: new Date("2026-02-03T06:00:00Z") }),
    ];
    const s = summarize(entries);
    const payload: ReportPayload = {
      period: { type: "monthly", key: m.key, label: m.label, start: iso(m.start), end: iso(m.end), startDay: m.startDay, endDay: m.endDay },
      generatedAt: "2026-02-10T12:00:00.000Z",
      currency: "PKR",
      summary: s,
      previous: s,
      delta: { creditPct: 0, debitPct: 0 },
      openingBalanceMinor: 20000,
      closingBalanceMinor: 20000 + s.netMinor,
      series: [],
      vendors: [],
      aging: [],
      openLots: [],
      topTransactions: entries,
      counts: { messagesParsed: 0, autoPosted: 0 },
      timeZone: PKT,
      entries,
      lineItems: [
        {
          transactionId: 11,
          vendorId: 1,
          vendorName: "Test Vendor",
          occurredAt: entries[0].occurredAt,
          entryType: "credit",
          reference: "=1+1",
          currency: "PKR",
          name: "Cement",
          sku: null,
          qty: 5,
          unit: "bag",
          unitPriceMinor: 30000,
          lineTotalMinor: 150000,
        },
      ],
    };
    const csv = reportToCsv(payload, "Ahmed, Traders");
    const lines = csv.split("\r\n");
    const unsafe = lines.some((l) => l.split(",").some((c) => /^"?[=@]/.test(c)));
    return [
      csv.includes("Summary,Credit,1500.00") &&
        csv.includes("Summary,Opening balance,200.00") &&
        csv.includes("Order item") &&
        csv.includes("Cement") &&
        csv.includes(",1200.00,") && // running balance after both entries: 200 + 1500 - 500
        csv.includes('"Ahmed, Traders"') &&
        csv.includes("Open lot") &&
        !unsafe,
      `${lines.length} lines unsafe=${unsafe}`,
    ];
  });

  return results;
}
