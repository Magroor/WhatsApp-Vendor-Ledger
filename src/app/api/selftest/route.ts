import { ok } from "@/lib/api";
import { runSelfTests, summarizeTests } from "@/lib/selftest";
import { runIngestSelfTests } from "@/lib/selftest-ingest";
import { runReportSelfTests } from "@/lib/selftest-reports";
import { draftsFromChat, parseChatExport } from "@/lib/chatimport";
import { parseLedgerText } from "@/lib/parse";
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

export async function GET() {
  const results = [...runSelfTests(), ...runIngestSelfTests(), ...runReportSelfTests(), ...chatImportTests(), ...romanUrduTests()];
  const summary = summarizeTests(results);
  return ok({ ...summary, results }, summary.failed === 0 ? 200 : 500);
}
