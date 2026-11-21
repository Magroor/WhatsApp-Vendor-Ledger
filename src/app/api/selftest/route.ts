import { ok } from "@/lib/api";
import { runSelfTests, summarizeTests } from "@/lib/selftest";
import { runIngestSelfTests } from "@/lib/selftest-ingest";
import { runReportSelfTests } from "@/lib/selftest-reports";
import { runPlannerSelfTests } from "@/lib/selftest-planner";
import { runPriceSelfTests } from "@/lib/selftest-prices";
import { runAllocationSelfTests } from "@/lib/selftest-allocations";
import { runCustomerSelfTests } from "@/lib/selftest-customers";
import { runPushSelfTests } from "@/lib/selftest-push";
import { draftsFromChat, parseChatExport } from "@/lib/chatimport";
import { parseLedgerText } from "@/lib/parse";
import { headerNameIn, normName, phonesIn } from "@/lib/aliases";
import type { TestResult } from "@/lib/selftest";

export const dynamic = "force-dynamic";

function chatImportTests(): TestResult[] {
  const ios = "[12/02/2026, 10:15:32] Ahmed: 5 bags cement total 7500 udhaar\n[13/02/2026, 09:00:00] Me: paid Rs 3,000 via easypaisa\nthanks";
  const android = "12/02/2026, 10:15 - Ahmed: Bill #55 total 12k udhaar\n14/02/2026, 11:00 - Me: <Media omitted>";
  const a = draftsFromChat(parseChatExport(ios), { currency: "PKR", defaultTermDays: 30 });
  const b = parseChatExport(android);
  return [
    { suite: "import", name: "iOS export parsed", pass: a.length === 2 && a[0].at.getMonth() === 1, detail: String(a.length) },
    { suite: "import", name: "continuation line joined", pass: a[1]?.text.includes("thanks") === true, detail: a[1]?.text ?? "" },
    { suite: "import", name: "credit + debit found", pass: a[0]?.draft.entryType === "credit" && a[1]?.draft.entryType === "debit", detail: `${a[0]?.draft.entryType}/${a[1]?.draft.entryType}` },
    { suite: "import", name: "android export, media skipped", pass: b.length === 1 && b[0].sender === "Ahmed", detail: String(b.length) },
  ];
}

/** Roman Urdu phrasing as vendors actually write it: [message, expected type, expected rupees]. */
const ROMAN_URDU: Array<[string, "credit" | "debit" | null, number | null]> = [
  ["kay hal hain?", null, null],
  ["assalam o alaikum bhai kya hal hai", null, null],
  ["bhai kal ka hisab bata do", null, null],
  ["5000 rupay mil gaye shukriya", "debit", 5000],
  ["bhai 5000 rupay bhej diye", "debit", 5000],
  ["paise ada kar diye 7500", "debit", 7500],
  ["20 hazar wasool hue", "debit", 20000],
  ["do hazar rupay jama kar diye easypaisa se", "debit", 2000],
  ["pachas hazar ka maal bheja hai", "credit", 50000],
  ["aaj 10 bori cement liya, kul 15000 udhaar likh lo", "credit", 15000],
  ["maal liya 12 hazar baaki", "credit", 12000],
  ["kitna baqaya hai bhai", null, null],
];

function romanUrduTests(): TestResult[] {
  return ROMAN_URDU.map(([text, type, rupees]) => {
    const d = parseLedgerText(text, { currency: "PKR" });
    const amount = d.amountMinor === null ? null : d.amountMinor / 100;
    // Messages with no amount are chat, not ledger entries: nothing may be posted.
    const pass = rupees === null ? d.amountMinor === null : d.entryType === type && amount === rupees;
    return { suite: "roman-urdu", name: text, pass, detail: `${d.entryType ?? "-"} ${amount ?? "-"} (conf ${d.confidence})` };
  });
}


/** Urdu-script bills: totals by word, Urdu digits, and tables that only list line amounts. */
function urduBillTests(): TestResult[] {
  const table = [
    "| 1 | 36 | لیبی فائل | 168/- | 6048 |",
    "| 2 | 05 | بیلٹ | 260 | 1300 |",
    "| 3 | 06 | مارکر | 45 | 270 |",
    "| 4 | 06 | مارکر | 90 | 540 |",
  ].join("\n");
  const cases: Array<[string, string, number | null]> = [
    ["urdu total word میزان", ["تعداد | تفصیل | رقم", "13000 -", "500 -", "کل: 13500/-", "میزان: 13500/"].join("\n"), 13500],
    ["urdu digits in total", "میزان: ٨١٥٨", 8158],
    ["bare total row = sum of the lines", `${table}
| | | | | 8158 |`, 8158],
    ["table with total word beats prices", `${table}\nمیزان: 8158`, 8158],
    ["'kal 3 carton' means yesterday, not total", "کل 3 carton oil diye", null],
    ["a phone number is not an amount", "call me on 03001234567 please", null],
    ["dashed phone is not an amount", "Tel 0304-9429269 total 13500", 13500],
  ];
  return cases.map(([name, text, expected]) => {
    const d = parseLedgerText(text, { currency: "PKR" });
    const got = d.amountMinor === null ? null : d.amountMinor / 100;
    return { suite: "urdu-bills", name, pass: got === expected, detail: `got ${got} want ${expected}` };
  });
}


function aliasTests(): TestResult[] {
  const bill = "مہران انٹرنیشنل فائل\n26-کبیر سٹریٹ، لاہور\nTel: 042-37245855\nMob: 0333-4428904, 0312-4428904\nتاریخ: 3/3/21";
  const phones = phonesIn(bill);
  const header = headerNameIn(bill);
  return [
    { suite: "aliases", name: "header line is the shop name", pass: header === "مہران انٹرنیشنل فائل", detail: String(header) },
    { suite: "aliases", name: "mobile numbers found as last 10 digits", pass: phones.includes("3334428904") && phones.includes("3124428904"), detail: phones.join(",") },
    { suite: "aliases", name: "name normalising ignores case and punctuation", pass: normName("  Ahmed  TRADERS. ") === "ahmed traders", detail: normName("  Ahmed  TRADERS. ") },
    { suite: "aliases", name: "printed form label is not a shop name", pass: headerNameIn("نام دوکاندار:\nنام خریدار: \nنمبر: 67\nپرو وئیر دالو مساجد\n0304-9429269") === "پرو وئیر دالو مساجد", detail: String(headerNameIn("نام دوکاندار:\nنام خریدار: \nنمبر: 67\nپرو وئیر دالو مساجد\n0304-9429269")) },
    { suite: "aliases", name: "blank pad with only labels learns no name", pass: headerNameIn("نام دوکاندار:\nنام خریدار:\nنمبر: 67") === null, detail: String(headerNameIn("نام دوکاندار:\nنام خریدار:\nنمبر: 67")) },
    { suite: "aliases", name: "english form labels are skipped", pass: headerNameIn("Customer's Name:\nAddress\nAL NOOR TRADERS") === "AL NOOR TRADERS", detail: String(headerNameIn("Customer's Name:\nAddress\nAL NOOR TRADERS")) },
    { suite: "aliases", name: "a date or total line is not a shop name", pass: headerNameIn("Total 5000\nDate 3/3/21") === null, detail: String(headerNameIn("Total 5000\nDate 3/3/21")) },
  ];
}

export async function GET() {
  const results = [...runSelfTests(), ...runIngestSelfTests(), ...runReportSelfTests(), ...chatImportTests(), ...romanUrduTests(), ...urduBillTests(), ...aliasTests(), ...runPlannerSelfTests(), ...runPriceSelfTests(), ...runAllocationSelfTests(), ...runCustomerSelfTests(), ...runPushSelfTests()];
  const summary = summarizeTests(results);
  return ok({ ...summary, results }, summary.failed === 0 ? 200 : 500);
}
