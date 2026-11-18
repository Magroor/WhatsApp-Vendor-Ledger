import crypto from "node:crypto";
import { buildSeries, computeOpenLots, periodRange, summarize, type LedgerRow } from "./reports";
import { formatMinor, toMinor } from "./money";
import {
  buildConfirmationText,
  classifyEntryType,
  extractItems,
  extractOccurredAt,
  extractReference,
  extractTermDays,
  parseLedgerText,
} from "./parse";
import { reportToCsv } from "./reports";
import { verifySignature } from "./wa";

export type TestResult = { suite: string; name: string; pass: boolean; detail: string };

function makeRow(partial: Partial<LedgerRow> & { id: number; entryType: "credit" | "debit"; amountMinor: number; occurredAt: Date }): LedgerRow {
  return {
    vendorId: partial.vendorId ?? 1,
    vendorName: partial.vendorName ?? "Test Vendor",
    vendorPhone: partial.vendorPhone ?? "923001234567",
    currency: partial.currency ?? "PKR",
    taxMinor: partial.taxMinor ?? 0,
    dueDate: partial.dueDate ?? null,
    status: partial.status ?? "confirmed",
    source: partial.source ?? "whatsapp",
    reference: partial.reference ?? null,
    description: partial.description ?? null,
    confidence: partial.confidence ?? 90,
    messageId: partial.messageId ?? null,
    ...partial,
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

export function runSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const check = (suite: string, name: string, pass: boolean, detail: string) =>
    results.push({ suite, name, pass, detail });

  // ---- money maths
  check("money", "parses comma + decimals", toMinor("15,000.50") === 1500050, `toMinor("15,000.50")=${toMinor("15,000.50")}`);
  check("money", "parses shorthand k", toMinor("12k") === 1200000, `toMinor("12k")=${toMinor("12k")}`);
  check("money", "parses lakh", toMinor("1.5 lakh") === 15000000, `toMinor("1.5 lakh")=${toMinor("1.5 lakh")}`);
  check("money", "formats with grouping", formatMinor(1010000, "PKR") === "Rs10,100", formatMinor(1010000, "PKR"));
  check("money", "negative balance renders", formatMinor(-2500, "PKR") === "-Rs25", formatMinor(-2500, "PKR"));

  // ---- parser: structured bill
  const bill = parseLedgerText(
    "Ahmed Traders\nBill #1042 - 12 Feb\n5 bags cement @ 1480\n3 boxes fittings @ 900\nTotal 10100 udhaar",
    { currency: "PKR", now: new Date("2026-02-14T10:00:00Z") },
  );
  check("parser", "bill total extracted", bill.amountMinor === 1010000, String(bill.amountMinor));
  check("parser", "bill direction = credit", bill.entryType === "credit", String(bill.entryType));
  check("parser", "bill reference found", bill.reference === "1042", String(bill.reference));
  check("parser", "line items parsed", bill.items.length === 2 && bill.items[0].name === "Cement", JSON.stringify(bill.items));
  check("parser", "high confidence auto-post", bill.confidence >= 75, String(bill.confidence));

  // ---- parser: payment / debit
  const payment = parseLedgerText("Payment received via easypaisa Rs 8,000 against bill #1042", { currency: "PKR" });
  check("parser", "payment classified debit", payment.entryType === "debit", String(payment.entryType));
  check("parser", "payment amount 8000", payment.amountMinor === 800000, String(payment.amountMinor));
  check("parser", "payment mode detected", payment.paymentMode === "easypaisa", String(payment.paymentMode));

  // ---- parser: voice-note style dictation
  const voice = parseLedgerText("add 5 bags of cement on credit for Ahmed total 7500", { currency: "PKR" });
  check("parser", "voice dictation credit", voice.entryType === "credit", String(voice.entryType));
  check("parser", "voice dictation vendor guess", (voice.vendorNameGuess ?? "").toLowerCase().includes("ahmed"), String(voice.vendorNameGuess));

  // ---- parser: malformed / mixed language resilience
  const messy = parseLedgerText("bhai kal ka hisab\nsaria 2 bundle 127000\npaise ka pata nahi", { currency: "PKR" });
  check("parser", "messy input does not crash", messy !== null && typeof messy.confidence === "number", `conf=${messy.confidence}`);
  check("parser", "messy input still finds amount", messy.amountMinor === 25400000, String(messy.amountMinor));

  const garbage = parseLedgerText("👍👍 good morning", { currency: "PKR" });
  check("parser", "no-amount message rejected", garbage.amountMinor === null, String(garbage.amountMinor));

  // ---- parser: currency symbols & OCR-ish text
  const ocrText = "INVOICE\nM/S DELTA PAINTS\nQTY 12 GALLON @ 8,400\nTOTAL AMOUNT: Rs.100,800";
  const ocr = parseLedgerText(ocrText, { currency: "PKR" });
  check("parser", "ocr total with label", ocr.amountMinor === 10080000, String(ocr.amountMinor));
  check("parser", "ocr items extracted", extractItems(ocrText).length >= 1, String(extractItems(ocrText).length));

  // ---- regressions: shorthand multipliers keep their k / lakh / crore
  check("money", "parses crore glued", toMinor("2cr") === 2000000000, `toMinor("2cr")=${toMinor("2cr")}`);
  check("money", "currency prefix + lakh", toMinor("Rs.1.5lakh") === 15000000, `toMinor("Rs.1.5lakh")=${toMinor("Rs.1.5lakh")}`);
  const fiveK = parseLedgerText("cement 5k udhaar", { currency: "PKR" });
  check("parser", "shorthand 5k -> 5000", fiveK.amountMinor === 500000, String(fiveK.amountMinor));
  const lakhAmt = parseLedgerText("Rs 1.5 lakh ka maal bheja", { currency: "PKR" });
  check("parser", "Rs 1.5 lakh -> 150000", lakhAmt.amountMinor === 15000000, String(lakhAmt.amountMinor));
  const totalK = parseLedgerText("total 12k udhaar", { currency: "PKR" });
  check("parser", "total 12k -> 12000", totalK.amountMinor === 1200000, String(totalK.amountMinor));

  // ---- regressions: payment terms need a unit (or "net N"); due dates use `now`
  const termNow = new Date(2026, 1, 14, 10, 0, 0);
  check("parser", "udhaar 5000 is not a 365-day term", extractTermDays("udhaar 5000", termNow) === null, String(extractTermDays("udhaar 5000", termNow)));
  check("parser", "credit 30 din -> 30", extractTermDays("credit 30 din", termNow) === 30, String(extractTermDays("credit 30 din", termNow)));
  check("parser", "net 45 -> 45", extractTermDays("terms net 45", termNow) === 45, String(extractTermDays("terms net 45", termNow)));
  check("parser", "due date measured from now", extractTermDays("due 24/02/2026", termNow) === 10, String(extractTermDays("due 24/02/2026", termNow)));

  // ---- regressions: decimals are not dates
  const dateNow = new Date(2026, 1, 14, 10, 0, 0);
  check("parser", "2.5 kg is not a date", extractOccurredAt("2.5 kg sugar @ 180", dateNow).date === null, String(extractOccurredAt("2.5 kg sugar @ 180", dateNow).text));
  check("parser", "1.5 lakh is not a date", extractOccurredAt("Rs 1.5 lakh", dateNow).date === null, String(extractOccurredAt("Rs 1.5 lakh", dateNow).text));
  const slashDate = extractOccurredAt("bill dated 12/02/2026", dateNow).date;
  check("parser", "12/02/2026 still a date", slashDate?.getDate() === 12 && slashDate?.getMonth() === 1, String(slashDate));
  const dotDate = extractOccurredAt("dated 10.02.2026", dateNow).date;
  check("parser", "dotted date with year", dotDate?.getDate() === 10 && dotDate?.getMonth() === 1, String(dotDate));

  // ---- regressions: references need word boundaries and real values
  check("parser", "'bill for cement' has no ref", extractReference("bill for cement") === null, String(extractReference("bill for cement")));
  check("parser", "'billed' has no ref", extractReference("billed to Ahmed 5 bags") === null, String(extractReference("billed to Ahmed 5 bags")));
  check("parser", "'no' needs digits", extractReference("no problem bhai") === null, String(extractReference("no problem bhai")));
  check("parser", "Bill No. 1042 -> 1042", extractReference("Bill No. 1042 dated 12/02") === "1042", String(extractReference("Bill No. 1042 dated 12/02")));

  // ---- regressions: direction words match whole words only
  const payable = classifyEntryType("balance payable 5000");
  check("parser", "payable/balance alone not debit", payable.entryType !== "debit", `${payable.entryType} ${payable.signals.join(",")}`);
  const billed = classifyEntryType("billed");
  check("parser", "billed counts once", billed.signals.join(",") === "credit:billed", billed.signals.join(","));
  check("parser", "roman urdu udhaar still credit", classifyEntryType("5 bori cheeni udhaar").entryType === "credit", String(classifyEntryType("5 bori cheeni udhaar").entryType));
  check("parser", "multi-word 'payment received' debit", classifyEntryType("payment  received").entryType === "debit", String(classifyEntryType("payment  received").entryType));

  // ---- regressions: "net 30" / lone "balance" are not top-weight amounts
  const netTerm = parseLedgerText("Invoice 7 bags cement Rs 9,800 net 30 days", { currency: "PKR" });
  check("parser", "net 30 days not the amount", netTerm.amountMinor === 980000, String(netTerm.amountMinor));
  check("parser", "net 30 days -> term 30", netTerm.termDays === 30, String(netTerm.termDays));
  const balanceAmt = parseLedgerText("paid Rs 5,000 balance 20000", { currency: "PKR" });
  check("parser", "lone balance not weighted over paid amount", balanceAmt.amountMinor === 500000, String(balanceAmt.amountMinor));

  // ---- caption + OCR combined
  const combined = parseLedgerText(
    ["Ahmed bhai ka bill, 30 din udhaar", "INVOICE\nBill No 2231\n10 bags cement @ 1500\nTOTAL AMOUNT: Rs.15,000"],
    { currency: "PKR", now: new Date(2026, 1, 14) },
  );
  check(
    "parser",
    "caption + ocr sections combined",
    combined.amountMinor === 1500000 && combined.reference === "2231" && combined.termDays === 30 && combined.entryType === "credit" && combined.items.length === 1,
    `${combined.amountMinor} ${combined.reference} ${combined.termDays} ${combined.entryType} items=${combined.items.length}`,
  );

  // ---- ledger engine
  const rows: LedgerRow[] = [
    makeRow({ id: 1, entryType: "credit", amountMinor: 1000000, occurredAt: daysAgo(70), dueDate: daysAgo(40).toISOString().slice(0, 10) }),
    makeRow({ id: 2, entryType: "credit", amountMinor: 500000, occurredAt: daysAgo(20), dueDate: daysAgo(-10).toISOString().slice(0, 10) }),
    makeRow({ id: 3, entryType: "debit", amountMinor: 700000, occurredAt: daysAgo(15) }),
    makeRow({ id: 4, entryType: "debit", amountMinor: 200000, occurredAt: daysAgo(5) }),
  ];
  const lots = computeOpenLots(rows);
  const oldest = lots.find((l) => l.transactionId === 1);
  const newest = lots.find((l) => l.transactionId === 2);
  check(
    "ledger",
    "FIFO settlement clears oldest bills first",
    oldest?.remainingMinor === 100000 && newest?.remainingMinor === 500000,
    `oldest=${oldest?.remainingMinor} newest=${newest?.remainingMinor}`,
  );
  check("ledger", "aging bucket uses bill age", (oldest?.ageDays ?? 0) >= 60, String(oldest?.ageDays));
  const summary = summarize(rows);
  check("ledger", "net = credit - debit", summary.netMinor === 600000, String(summary.netMinor));
  check("ledger", "running balance precision exact", formatMinor(summary.netMinor, "PKR") === "Rs6,000", formatMinor(summary.netMinor, "PKR"));

  // ---- periods
  const week = periodRange("weekly", new Date("2026-02-18T12:00:00Z"));
  check("reports", "week starts on Monday", new Date(`${week.startDay}T00:00:00Z`).getUTCDay() === 1, week.startDay);
  const month = periodRange("monthly", new Date("2026-02-18T12:00:00Z"));
  check("reports", "month ends on last day", month.endDay === "2026-02-28", month.endDay);
  const year = periodRange("yearly", new Date("2026-02-18T12:00:00Z"));
  check("reports", "year spans Jan 1 -> Dec 31", year.key === "2026" && year.endDay === "2026-12-31", year.endDay);
  check("reports", "weekly series has 7 buckets", buildSeries(rows, "weekly", week).length === 7, String(buildSeries(rows, "weekly", week).length));

  // ---- export
  const csv = reportToCsv(
    {
      period: { type: "monthly", key: "2026-02", label: "February 2026", start: month.start.toISOString(), end: month.end.toISOString() },
      generatedAt: new Date().toISOString(),
      currency: "PKR",
      summary,
      previous: summary,
      delta: { creditPct: 0, debitPct: 0 },
      openingBalanceMinor: 0,
      closingBalanceMinor: summary.netMinor,
      series: [],
      vendors: [],
      aging: [],
      openLots: [],
      topTransactions: rows,
      counts: { messagesParsed: 4, autoPosted: 4 },
    },
    "Test Vendor",
  );
  check("export", "csv contains sections", csv.includes("Summary,Credit") && csv.includes("Open lot"), `${csv.split("\n").length} lines`);

  // ---- reply bot text
  const reply = buildConfirmationText({
    businessName: "My Shop",
    vendorName: "Ahmed Traders",
    entryType: "credit",
    amountMinor: 1010000,
    currency: "PKR",
    reference: "1042",
    balanceMinor: 1010000,
    items: bill.items,
  });
  check("bot", "confirmation includes ref & balance", reply.includes("1042") && reply.includes("Rs10,100"), reply.split("\n")[2] ?? "");

  // ---- security
  const secret = "test-app-secret";
  const body = '{"entry":[{"changes":[]}]}';
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  check("security", "valid signature accepted", verifySignature(body, `sha256=${sig}`, secret).ok, "hmac ok");
  check("security", "tampered signature rejected", !verifySignature(`${body} `, `sha256=${sig}`, secret).ok, "tamper blocked");
  check("security", "missing secret fails closed", !verifySignature(body, "sha256=deadbeef", "another-secret").ok, "reject");

  return results;
}

export function summarizeTests(results: TestResult[]) {
  const failed = results.filter((r) => !r.pass);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    suites: [...new Set(results.map((r) => r.suite))],
    failures: failed,
  };
}
