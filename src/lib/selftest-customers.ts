import { labelsFor, normalizeKind, splitBalances } from "./kind";
import { buildCustomerReminderText, buildPartyReminderText, buildReminderText } from "./reminder";
import type { TestResult } from "./selftest";
import { cleanVendorInput } from "./vendor-input";

const SUITE = "customers";

/** Pure checks for customers (receivables): labels, payable/receivable split, reminder text, input validation. */
export function runCustomerSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ suite: SUITE, name, pass, detail });

  const v = labelsFor("vendor");
  const c = labelsFor("customer");
  check(
    "labelsFor vendor wording",
    v.noun === "Vendor" && v.creditTitle === "Bill" && v.debitTitle === "Paid" && v.balanceLabel === "You owe" && v.khataTitle === "Vendor khata",
    `${v.noun} / ${v.creditTitle} / ${v.debitTitle} / ${v.balanceLabel}`,
  );
  check(
    "labelsFor customer wording",
    c.noun === "Customer" &&
      c.nounPlural === "Customers" &&
      c.creditTitle === "Sale on credit" &&
      c.creditHint === "they owe me" &&
      c.debitTitle === "Payment received" &&
      c.balanceLabel === "They owe you" &&
      c.khataTitle === "Customer khata",
    `${c.noun} / ${c.creditTitle} / ${c.debitTitle} / ${c.balanceLabel}`,
  );
  check(
    "unknown kind falls back to vendor",
    normalizeKind(undefined) === "vendor" && normalizeKind("CUSTOMER?") === "vendor" && labelsFor(null).noun === "Vendor",
    `undefined -> ${normalizeKind(undefined)}`,
  );

  const split = splitBalances([
    { kind: "vendor", balanceMinor: 500_000 },
    { kind: "vendor", balanceMinor: -20_000 },
    { kind: "customer", balanceMinor: 300_000 },
    { kind: "customer", balanceMinor: 125_050 },
    { kind: "customer", balanceMinor: -5_000 },
    { kind: undefined, balanceMinor: 100 },
    { kind: "customer", balanceMinor: 0 },
  ]);
  check(
    "payable = positive vendor balances only",
    split.payableMinor === 500_100,
    `payable ${split.payableMinor}`,
  );
  check(
    "receivable = positive customer balances only",
    split.receivableMinor === 425_050,
    `receivable ${split.receivableMinor}`,
  );
  check(
    "advances are split out (vendor and customer)",
    split.vendorAdvanceMinor === 20_000 && split.customerAdvanceMinor === 5_000,
    `vendor adv ${split.vendorAdvanceMinor}, customer adv ${split.customerAdvanceMinor}`,
  );
  const empty = splitBalances([]);
  check(
    "empty list splits to zeros",
    empty.payableMinor === 0 && empty.receivableMinor === 0 && empty.vendorAdvanceMinor === 0 && empty.customerAdvanceMinor === 0,
    JSON.stringify(empty),
  );

  const params = {
    businessName: "Madina Store",
    vendorName: "Bilal Khan",
    balanceMinor: 1_250_000,
    currency: "PKR",
    oldestAgeDays: 40,
    termsDays: 30,
  };
  const customerText = buildCustomerReminderText(params);
  check(
    "customer reminder is a polite payment request",
    customerText.startsWith("Assalam o Alaikum, Bilal Khan.") &&
      customerText.includes("Your balance with Madina Store is") &&
      customerText.includes("12,500") &&
      customerText.includes("Please send payment when convenient. Shukriya.") &&
      !customerText.includes("Vendor:"),
    customerText.replace(/\n/g, " | "),
  );
  const vendorText = buildPartyReminderText("vendor", params);
  check(
    "vendor reminder keeps the old wording",
    vendorText === buildReminderText(params) && vendorText.includes("Vendor: Bilal Khan") && vendorText.includes("40 days old"),
    vendorText.replace(/\n/g, " | "),
  );
  check(
    "buildPartyReminderText picks customer text by kind",
    buildPartyReminderText("customer", params) === customerText,
    "customer kind -> customer text",
  );

  const ok = cleanVendorInput({ name: "CUSTOMER TEST Bilal", kind: "customer" });
  check(
    "cleanVendorInput accepts kind=customer",
    "values" in ok && ok.values.kind === "customer",
    JSON.stringify(ok),
  );
  const okVendor = cleanVendorInput({ kind: " Vendor " }, { partial: true });
  check(
    "cleanVendorInput accepts kind=vendor (trimmed, any case)",
    "values" in okVendor && okVendor.values.kind === "vendor",
    JSON.stringify(okVendor),
  );
  const bad = cleanVendorInput({ name: "Someone", kind: "supplier" });
  check("cleanVendorInput rejects unknown kind", "error" in bad, JSON.stringify(bad));
  const none = cleanVendorInput({ name: "Someone" });
  check(
    "cleanVendorInput leaves kind unset when absent",
    "values" in none && none.values.kind === undefined,
    JSON.stringify(none),
  );

  return results;
}
