import { toMinor } from "./money";

/**
 * WhatsApp ledger text parser.
 * Pure functions only (no IO) so it is unit-testable and safe to run on a
 * background worker. Handles English + Roman Urdu/Hindi phrasing which is how
 * vendors actually dictate bills over WhatsApp.
 */

export type EntryType = "credit" | "debit";

export type ParsedItem = {
  name: string;
  sku?: string | null;
  qty: number;
  unit?: string | null;
  unitPriceMinor?: number | null;
  lineTotalMinor?: number | null;
};

export type ParsedDraft = {
  entryType: EntryType | null;
  amountMinor: number | null;
  currency: string | null;
  reference: string | null;
  description: string | null;
  paymentMode: string | null;
  items: ParsedItem[];
  occurredAtHint: Date | null;
  occurredAtText: string | null;
  termDays: number | null;
  vendorNameGuess: string | null;
  confidence: number;
  signals: string[];
  notes: string[];
};

export type ParseOptions = {
  currency?: string;
  now?: Date;
  defaultTermDays?: number;
  senderName?: string | null;
};

const CREDIT_WORDS = [
  "udhaar", "udhar", "udhār", "credit", "credited", "khata", "khate", "billed",
  "bill", "billa", "invoice", "purchase", "purchased", "maal", "supply",
  "supplied", "goods", "lena", "liya", "aaya", "aana", "receivable", "len den",
  "on credit", "pending", "dena hai", "chahiye", "baki", "baqi", "udhari",
  "udhaari",
];

const DEBIT_WORDS = [
  "paid", "payment", "pay", "payed", "debit", "debited", "jama", "deposit",
  "deposited", "settled", "settlement", "cleared", "transfer", "transferred",
  "sent", "remitted", "advance", "advance paid", "cash", "easypaisa",
  "jazzcash", "nayapay", "sadapay", "bank", "cheque", "check", "neft", "imps",
  "rtgs", "upi", "adiye", "adaigi", "hisab", "clear", "reimburse",
  "payment received", "received payment", "against bill", "bheje", "bhej diye",
  "ada kiye", "wasool",
  "mil gaye", "mil gaya", "mil gayi", "mil gai", "ada kar", "ada kia", "ada kiya",
  "ada ho gaye", "wasooli", "wasool hue", "wasool hua", "de diye", "de diya",
  "bhej diya", "bhijwa diye", "bhijwa diya", "jama kar", "jama karwa",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word matcher: "pay" must not hit "payable", "bill" must not hit
 * "billed". Multi-word phrases tolerate any run of whitespace. Uses Unicode
 * letter classes so Roman Urdu with diacritics ("udhār") is bounded too.
 */
function wordRe(word: string): RegExp {
  const body = word.trim().split(/\s+/).map(escapeRe).join(String.raw`\s+`);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${body}(?![\p{L}\p{N}])`, "iu");
}

const CREDIT_RES: Array<[string, RegExp]> = CREDIT_WORDS.map((w) => [w, wordRe(w)]);
const DEBIT_RES: Array<[string, RegExp]> = DEBIT_WORDS.map((w) => [w, wordRe(w)]);

const PAYMENT_MODES: Array<[RegExp, string]> = [
  [/\beasypaisa\b|\beasypaisa? ac\b/i, "easypaisa"],
  [/\bjazzcash\b/i, "jazzcash"],
  [/\bnayapay\b|\bsadapay\b/i, "wallet"],
  [/\bbank\b|\bneft\b|\bimps\b|\brtgs\b|\biban\b|\btransfer\b/i, "bank"],
  [/\bcheque\b|\bcheck no\b|\bchk\b/i, "cheque"],
  [/\bupi\b/i, "upi"],
  [/\bcash\b/i, "cash"],
  [/\bcard\b|\bvisa\b|\bmastercard\b/i, "card"],
];

const UNITS = [
  "gallons", "gallon", "litres", "liters", "litre", "liter", "grams", "gram",
  "pieces", "piece", "packets", "packet", "cartons", "carton", "bundles",
  "bundle", "crates", "crate", "meters", "meter", "sacks", "sack", "trays",
  "tray", "boxes", "box", "bags", "bag", "packs", "pack", "rolls", "roll",
  "pairs", "pair", "sheet", "sheets", "cases", "case", "sets", "set", "cans",
  "can", "ream", "reams", "kg", "g", "pcs", "dozen", "dzn", "ltr", "ft",
  "feet", "ton", "tons", "gaz", "man", "hour", "hours", "day", "days", "unit",
  "units", "m",
];

const UNIT_RE = UNITS.join("|");

const NAME_STOPWORDS = new Set([
  "add", "bhai", "please", "kindly", "enter", "new", "total", "amount", "rs",
  "rupees", "udhaar", "udhar", "credit", "debit", "paid", "payment", "bill",
  "invoice", "for", "from", "the", "aaj", "kal", "yesterday", "today", "on",
  "of", "via", "received", "sent",
]);

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
];

export function normalizeText(raw: string): string {
  return (raw ?? "")
    // Urdu/Arabic digits (٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹) -> 0-9 so amounts in Urdu script are read
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200f]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type AmountCandidate = {
  value: number;
  weight: number;
  label: string;
  index: number;
};

// Optional k / lakh / crore multiplier kept inside the captured token so toMinor
// sees "5k" rather than "5".
// "cr" only when glued to the number ("2cr"), since "5000 Cr" usually means credit.
const MULT = String.raw`(?:(?:\s*(?:k|thousand|lakhs?|lacs?|crores?)|cr)(?![a-z]))?`;
const NUM = String.raw`[0-9][0-9,]*(?:\.[0-9]{1,2})?`;
// Number must end cleanly (no further digits) and must not be a "N days/din" term.
const NUM_END = String.raw`(?![0-9])(?!\.[0-9])(?!\s*(?:din|days?)\b)`;
const MONEY_TOKEN = String.raw`(?:rs\.?|pkr|inr|usd|aed|sar|rupees|₹|\$)\s*(${NUM}${MULT})`;
const MONEY_TOKEN_AFTER = String.raw`(${NUM}${MULT})\s*(?:rs\.?|pkr|inr|rupees|rupee|rupay|rupaye|rupey|rupya|\/-|₹|\$|-rs)`;
// Plain numbers: no leading zero (phone numbers like 0300…), at most 9 digits (a 10+ digit run is a
// phone/ID), and not glued to more digits or a dash (0304-9429269, 2026-11-12).
const PLAIN_MONEY = String.raw`(?:^|[\s:=])(?!0[0-9])([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{4,9}(?:\.[0-9]{1,2})?)(?![0-9-])`;

function pushCandidate(
  list: AmountCandidate[],
  text: string,
  re: RegExp,
  weight: number,
  label: string,
) {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    // First participating capture group (some patterns have alternatives).
    const rawValue = m.slice(1).find((g) => g !== undefined && g !== "");
    if (!rawValue) continue;
    const value = toMinor(rawValue);
    if (value <= 0) continue;
    list.push({ value, weight, label, index: m.index });
    if (rx.lastIndex === m.index) rx.lastIndex += 1;
  }
}


/**
 * Tabular bills (very common handwritten Urdu bills) list line amounts and a total. When no
 * explicit total word was found, the total is the largest number that equals the sum of two or
 * more of the other numbers. Returns minor units, or null. Skips phone-like and year-like numbers.
 */
export function totalFromColumnSum(text: string): number | null {
  const tokens: number[] = [];
  for (const m of text.matchAll(/(?<![\d.,/-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d/])/g)) {
    const whole = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(whole) || whole < 10 || whole >= 1e9) continue;
    if (/^(19|20)\d\d$/.test(m[1])) continue; // a year
    if (m[1].length >= 10) continue; // a phone number
    tokens.push(Math.round((whole + (m[2] ? Number(`0.${m[2]}`) : 0)) * 100));
  }
  const nums = [...new Set(tokens)].slice(0, 18);
  if (nums.length < 3) return null;
  const sorted = [...nums].sort((a, b) => b - a);
  for (const total of sorted) {
    if (total < 10000) break; // below Rs 100 is not worth guessing
    const rest = nums.filter((n) => n < total);
    const limit = 1 << rest.length; // subset-sum over at most 17 numbers
    for (let mask = 1; mask < limit; mask += 1) {
      if ((mask & (mask - 1)) === 0) continue; // need 2+ numbers
      let sum = 0;
      for (let i = 0; i < rest.length; i += 1) if (mask & (1 << i)) sum += rest[i];
      if (sum === total) return total;
    }
  }
  return null;
}

export function extractAmountCandidates(text: string): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  // Explicit totals carry the highest weight.
  const CUR = String.raw`(?:rs\.?|pkr|rupees|₹)?`;
  // Explicit totals carry the highest weight. A bare "net" is excluded here
  // ("net 30" is a payment term) and so is a lone "balance" (weighted lower below).
  // Urdu total words. "کل" alone also means "yesterday", so it needs a 3+ digit number after it.
  pushCandidate(
    out,
    text,
    /(?:میزان|مجموعہ|مجموعه|ٹوٹل|کل\s*رقم|کل\s*میزان|جمع)\s*[:=\-]?\s*(?:rs\.?|روپے)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi,
    100,
    "explicit-total-urdu",
  );
  pushCandidate(
    out,
    text,
    /(?:^|[\s|])کل\s*[:=\-]?\s*(?:rs\.?|روپے)?\s*([0-9][0-9,]{2,}(?:\.[0-9]{1,2})?)/gi,
    96,
    "explicit-total-urdu-kul",
  );
  pushCandidate(
    out,
    text,
    new RegExp(
      String.raw`\b(?:grand\s*total|total\s*amount|net\s*amount|net\s*payable|net\s*total|total\s*payable|balance\s*(?:due|payable|amount)|total|amount|payable|sum|jama|ka\s*total|kitna|kital)\b\s*[:=\-]?\s*${CUR}\s*(${NUM}${MULT})${NUM_END}`,
      "gi",
    ),
    100,
    "explicit-total",
  );
  pushCandidate(out, text, new RegExp(MONEY_TOKEN + NUM_END, "gi"), 70, "currency-prefix");
  pushCandidate(out, text, new RegExp(MONEY_TOKEN_AFTER, "gi"), 70, "currency-suffix");
  pushCandidate(
    out,
    text,
    new RegExp(String.raw`\b(?:total|amount|payable)\b\s*[:=]?\s*(${NUM}${MULT})${NUM_END}`, "gi"),
    90,
    "total-keyword",
  );
  // Bare "net": an amount only with a currency marker or a 4+ digit / grouped
  // number, never "net 30" / "net 30 days".
  pushCandidate(
    out,
    text,
    new RegExp(
      String.raw`\bnet\b\s*[:=\-]?\s*(?:(?:rs\.?|pkr|rupees|₹)\s*(${NUM}${MULT})|([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{4,}(?:\.[0-9]{1,2})?))${NUM_END}`,
      "gi",
    ),
    90,
    "net-keyword",
  );
  // A lone "balance" is often an outstanding figure, not this entry's amount.
  pushCandidate(
    out,
    text,
    new RegExp(String.raw`\bbalance\b\s*[:=\-]?\s*${CUR}\s*(${NUM}${MULT})${NUM_END}`, "gi"),
    50,
    "balance-keyword",
  );
  // k / lakh / crore shorthand: the whole token ("5k", "1.5 lakh", "2cr") goes to toMinor.
  pushCandidate(
    out,
    text,
    /(?:rs\.?|pkr|rupees|₹)?\s*([0-9]+(?:\.[0-9]+)?\s*(?:k|thousand|lakhs?|lacs?|crores?)(?![a-z])|[0-9]+(?:\.[0-9]+)?cr(?![a-z]))/gi,
    60,
    "shorthand",
  );
  pushCandidate(out, text, new RegExp(PLAIN_MONEY, "g"), 40, "plain-number");
  return out;
}

function chooseAmount(candidates: AmountCandidate[]): number | null {
  if (candidates.length === 0) return null;
  const best = [...candidates].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.value !== a.value) return b.value - a.value;
    return a.index - b.index;
  })[0];
  return best.value;
}

function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function extractItems(text: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const lines = normalizeText(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && !/^[-=_*~\s]+$/.test(l));

  // Unit alternation is sorted longest-first so "bags" wins over "bag".
  const unitGroup = [...UNITS].sort((a, b) => b.length - a.length).join("|");

  type Pattern = { re: RegExp; kind: "qtyFirst" | "nameFirst" };
  const patterns: Pattern[] = [
    // "5 bags cement @ 1480" | "3 x steel rods at 900" | "2.5 kg sugar * 180"
    {
      kind: "qtyFirst",
      re: new RegExp(
        String.raw`^([0-9]+(?:\.[0-9]+)?)\s*(?:(${unitGroup})\b)?\s*(?:x|×|\*)?\s*([a-zA-Z\u0600-\u06FF][\w\u0600-\u06FF '&./()\-]*?)\s*(?:@|at|rate|each|for)\s*(?:rs\.?|pkr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)$`,
        "i",
      ),
    },
    // "sugar 5 kg @ 180" | "cement 50 bags 1200"
    {
      kind: "nameFirst",
      re: new RegExp(
        String.raw`^([a-zA-Z\u0600-\u06FF][\w\u0600-\u06FF '&./()\-]*?)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:(${unitGroup})\b)?\s*(?:@|at|rate|\bx\b|\*|×)?\s*(?:rs\.?|pkr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)$`,
        "i",
      ),
    },
    // SKU row: "SKU-1042, 3 pcs, 250"
    {
      kind: "nameFirst",
      re: new RegExp(
        String.raw`^([A-Z]{2,}[A-Z0-9\-/]{1,12})\s*[,|]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:(${unitGroup})\b)?\s*[,|]\s*(?:rs\.?|pkr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)$`,
        "i",
      ),
    },
  ];

  for (const rawLine of lines) {
    // Drop list markers and "qty:" style labels, keep "total" lines out entirely
    // unless they carry item data (e.g. "10 bags total 1200").
    let line = rawLine
      .replace(/^(?:qty|quantity|item|items|description|product)\s*[:.\-]?\s*/i, "")
      .replace(/^(?:\d{1,2}[.)]|[-*•·])\s*/, "");
    const isSummaryLine =
      /total|amount|payable|balance|thanks|shukriya|regards|udhaar|credit|debit|paid|payment|\b(?:bill|invoice|inv|receipt|challan|voucher)\s*(?:#|no\b|num(?:ber)?\b)|\bref(?:erence)?\b/i.test(
        line,
      );
    if (isSummaryLine && !/\btotal\b|\bamount\b/i.test(line)) continue;

    for (const pattern of patterns) {
      const m = line.match(pattern.re);
      if (!m) continue;
      const qtyToken = pattern.kind === "qtyFirst" ? m[1] : m[2];
      const unitToken = pattern.kind === "qtyFirst" ? m[2] : m[3];
      const nameToken = pattern.kind === "qtyFirst" ? m[3] : m[1];
      const priceToken = m[4];

      const name = (nameToken ?? "").trim().replace(/\s+/g, " ");
      const quantity = Number.parseFloat((qtyToken ?? "1").replace(/,/g, ""));
      const unit = (unitToken ?? "").trim().toLowerCase() || null;
      const unitPrice = toMinor((priceToken ?? "0").replace(/,/g, ""));

      if (!name || name.length < 2 || NAME_STOPWORDS.has(name.toLowerCase())) continue;
      if (["total", "amount", "balance", "payable", "net"].includes(name.toLowerCase())) continue;
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      if (unitPrice <= 0) continue;
      // A name that is mostly digits is not an item name (guards OCR noise).
      if (!/[a-zA-Z\u0600-\u06FF]{2,}/.test(name)) continue;

      items.push({
        name: titleCase(name),
        sku: null,
        qty: quantity,
        unit,
        unitPriceMinor: unitPrice,
        lineTotalMinor: Math.round(quantity * unitPrice),
      });
      break;
    }
  }
  return items;
}

export function classifyEntryType(text: string): {
  entryType: EntryType | null;
  signals: string[];
} {
  const t = text.toLowerCase();
  const signals: string[] = [];
  let credit = 0;
  let debit = 0;
  for (const [w, re] of CREDIT_RES) {
    if (re.test(t)) {
      credit += w.includes(" ") ? 3 : 2;
      signals.push(`credit:${w}`);
    }
  }
  for (const [w, re] of DEBIT_RES) {
    if (re.test(t)) {
      debit += w.includes(" ") ? 3 : 2;
      signals.push(`debit:${w}`);
    }
  }
  if (/\bcr\b|#credit|\(credit\)/i.test(text)) credit += 5;
  if (/\bdr\b|#debit|\(debit\)/i.test(text)) debit += 5;
  if (debit > credit) return { entryType: "debit", signals };
  if (credit > debit) return { entryType: "credit", signals };
  if (credit > 0 && credit === debit) return { entryType: "credit", signals };
  return { entryType: null, signals };
}

export function extractPaymentMode(text: string): string | null {
  for (const [re, mode] of PAYMENT_MODES) {
    if (re.test(text)) return mode;
  }
  return null;
}

const REF_STOPWORDS = new Set([
  "for", "from", "ed", "of", "the", "no", "num", "number", "ref", "and", "to",
  "is", "in", "on", "at", "by", "a", "an", "ka", "ki", "ke", "hai", "bhi",
  "date", "dated", "amount", "total", "paid", "payment", "pending", "attached",
  "copy", "please", "send", "bhej", "do", "dein", "with", "this", "that", "my",
  "your", "ko", "se", "aur", "udhaar", "credit", "cash", "original", "duplicate",
]);

export function extractReference(text: string): string | null {
  // Strong labels may carry an all-caps code ("INV-ABC"); generic labels
  // ("no", "ref", "number") must carry a digit. Matching never crosses a line.
  const labelled = /\b(bill|invoice|inv|receipt|voucher|challan|ref|reference|no|num|number)\b\.?[ \t]*(?:(?:no|num|number)\b\.?)?[ \t]*[:#\-]?[ \t]*#?[ \t]*([A-Za-z0-9][A-Za-z0-9\-/]{0,15})(?![A-Za-z0-9])/gi;
  const STRONG = new Set(["bill", "invoice", "inv", "receipt", "voucher", "challan"]);
  let m: RegExpExecArray | null;
  while ((m = labelled.exec(text)) !== null) {
    const label = m[1].toLowerCase();
    const value = m[2].replace(/[-/,.;:]+$/, "");
    if (value.length < 2 || REF_STOPWORDS.has(value.toLowerCase())) continue;
    if (/^\d{8,}$/.test(value)) continue; // phone / account numbers
    const hasDigit = /\d/.test(value);
    const allCaps = /^[A-Z0-9\-/]+$/.test(value) && value.length >= 3;
    if (hasDigit || (STRONG.has(label) && allCaps)) return value.toUpperCase();
  }
  // Bare "#1042" (not hashtags like "#credit").
  const hash = text.match(/(?<![\w&])#\s*([A-Za-z0-9][A-Za-z0-9\-/]{1,15})(?![A-Za-z0-9])/);
  if (hash) {
    const value = hash[1].replace(/[-/,.;:]+$/, "");
    if (/\d/.test(value) && !/^\d{8,}$/.test(value)) return value.toUpperCase();
  }
  return null;
}

const DATE_UNIT_GUARD = String.raw`(?!\s*(?:${[...UNITS, "din"].sort((a, b) => b.length - a.length).join("|")})\b)`;
// d/m(/y) or d-m(-y) with a consistent separator; not part of a larger number,
// not a currency amount ("5000/-"), not a quantity ("1/2 kg").
const DATE_SLASH_RE = new RegExp(
  String.raw`(?<![\d.,/\-])(?<!(?:rs\.?|pkr|inr|₹)\s*)(\d{1,2})([/\-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d/\-]|\.\d)${DATE_UNIT_GUARD}`,
  "gi",
);
// Dotted dates need an explicit year ("12.02.2026", "12.02.26") so decimals
// like "2.5 kg" or "1.5 lakh" never read as dates.
const DATE_DOT_RE = new RegExp(
  String.raw`(?<![\d.,])(?<!(?:rs\.?|pkr|inr|₹)\s*)(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d|\.\d)${DATE_UNIT_GUARD}`,
  "gi",
);

function parseNumericDate(
  text: string,
  now: Date,
  rollbackFuture: boolean,
): { date: Date; text: string } | null {
  type Hit = { index: number; day: string; month: string; year?: string; raw: string };
  const hits: Hit[] = [];
  for (const m of text.matchAll(DATE_SLASH_RE)) {
    hits.push({ index: m.index ?? 0, day: m[1], month: m[3], year: m[4], raw: m[0] });
  }
  for (const m of text.matchAll(DATE_DOT_RE)) {
    hits.push({ index: m.index ?? 0, day: m[1], month: m[2], year: m[3], raw: m[0] });
  }
  hits.sort((a, b) => a.index - b.index);
  for (const h of hits) {
    const day = Number.parseInt(h.day, 10);
    const month = Number.parseInt(h.month, 10);
    let year = h.year ? Number.parseInt(h.year, 10) : now.getFullYear();
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const d = new Date(year, month - 1, day, 12, 0, 0);
    if (d.getDate() !== day) continue; // e.g. 31/02
    if (rollbackFuture && !h.year && d.getTime() > now.getTime() + 36e5 * 24) {
      d.setFullYear(d.getFullYear() - 1);
    }
    return { date: d, text: h.raw };
  }
  return null;
}

export function extractOccurredAt(
  text: string,
  now: Date,
): { date: Date | null; text: string | null } {
  const t = text.toLowerCase();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (/\b(today|aaj|abhi|just now)\b/.test(t)) return { date: startOfToday, text: "today" };
  if (/\b(yesterday|kal|yesterday's)\b/.test(t)) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - 1);
    return { date: d, text: "yesterday" };
  }
  if (/\b(parso|day before yesterday|2 days ago|do din pehle)\b/.test(t)) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - 2);
    return { date: d, text: "2 days ago" };
  }
  const agoMatch = t.match(/(\d{1,2})\s*(?:din|days|day)\s*(?:pehle|ago|before)/);
  if (agoMatch) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - Number.parseInt(agoMatch[1], 10));
    return { date: d, text: `${agoMatch[1]} days ago` };
  }
  const numeric = parseNumericDate(text, now, true);
  if (numeric) return numeric;
  const dMon = text.match(
    /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
  ) ?? text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i);
  if (dMon) {
    const monthToken = (dMon[1].length <= 3 ? dMon[1] : dMon[2]).toLowerCase();
    const dayToken = Number.parseInt(
      dMon[1].length <= 3 ? dMon[2] : dMon[1],
      10,
    );
    const monthIndex = MONTHS.findIndex((m) => m.startsWith(monthToken));
    if (monthIndex >= 0 && dayToken >= 1 && dayToken <= 31) {
      const d = new Date(now.getFullYear(), monthIndex, dayToken, 12, 0, 0);
      if (d.getTime() > now.getTime() + 36e5 * 24) d.setFullYear(d.getFullYear() - 1);
      return { date: d, text: dMon[0] };
    }
  }
  return { date: null, text: null };
}

export function extractTermDays(text: string, now: Date = new Date()): number | null {
  const clamp = (n: string) => Math.min(365, Math.max(0, Number.parseInt(n, 10)));
  // "net 30" / "net-30" / "net 30 days" (but not "net 3000", "net amount 500").
  const net = text.match(/\bnet\s*[:\-]?\s*(\d{1,3})(?![\d,.])(?:\s*(?:din|days?)\b)?(?!\s*(?:rs|pkr|inr|rupees|\/-|k\b|lakh|lac))/i);
  if (net) return clamp(net[1]);
  // "due in 15 days", "credit 30 din", "terms: 45 days", "udhaar 7 din" — unit required.
  const labelled = text.match(
    /\b(?:due|credit|terms?|udhaar|udhar|payment\s+in|within|after)\b\s*(?:in|within|after)?\s*[:\-]?\s*(\d{1,3})\s*(?:din|days?)\b/i,
  );
  if (labelled) return clamp(labelled[1]);
  // "30 days credit", "15 din ka udhaar"
  const trailing = text.match(
    /\b(\d{1,3})\s*(?:din|days?)\s*(?:ka|ke|ki|of)?\s*(?:udhaar|udhar|credit|terms?|due)\b/i,
  );
  if (trailing) return clamp(trailing[1]);
  const dueDate = text.match(/\bdue\s*(?:on|date|by)?\s*[:\-]?\s*/i);
  if (dueDate && dueDate.index !== undefined) {
    const rest = text.slice(dueDate.index + dueDate[0].length, dueDate.index + dueDate[0].length + 16);
    // Due dates are naturally in the future: parse without the "roll back a year" rule.
    const parsed = parseNumericDate(rest, now, false);
    if (parsed && rest.startsWith(parsed.text)) {
      const d = parsed.date;
      const diff = Math.round(
        (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
          Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
          86400000,
      );
      if (diff >= 0) return Math.min(365, diff);
    }
  }
  return null;
}

export function guessVendorName(
  text: string,
  senderName?: string | null,
): string | null {
  const orgMatch = text.match(
    /\b([A-Z][A-Za-z&.' ]{2,40}(?:Traders|Trader|Store|Stores|Mart|Enterprises|Enterprise|Company|Co|Corporation|Sons|Shop|Suppliers|Supplier|Agency|Agencies|Distributors|Distributor|Hardware|Karyana|General Store|Trd|Pvt Ltd|Ltd))\b/,
  );
  if (orgMatch) return titleCase(orgMatch[1].trim());

  const labelled = text.match(
    /(?:vendor|party|customer|supplier|client|name)\s*[:\-]\s*([A-Za-z\u0600-\u06FF][\w\u0600-\u06FF '&.-]{1,40})/i,
  );
  if (labelled) return titleCase(labelled[1].trim());

  const forFrom = text.match(
    /\b(?:for|from|of|to)\s+([A-Z][a-z'&]+(?:\s+[A-Z][a-z'&.]+){0,2})\b/,
  );
  if (forFrom && !NAME_STOPWORDS.has(forFrom[1].toLowerCase())) {
    return titleCase(forFrom[1].trim());
  }

  const lineName = normalizeText(text)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^[A-Z][A-Za-z&.' ]{2,30}:$/.test(l));
  if (lineName) return titleCase(lineName.replace(/:$/, "").trim());

  if (senderName && senderName.trim().length > 1 && !/^\+?\d+$/.test(senderName)) {
    return titleCase(senderName.trim());
  }
  return null;
}

/**
 * Join several text sources (e.g. a WhatsApp caption plus OCR of the attached
 * image) into one parseable body. Sections are separated by a blank line so
 * line-based extractors never glue the last caption line onto the first OCR line.
 */
export function combineSections(raw: string | ReadonlyArray<string | null | undefined>): string {
  const parts = typeof raw === "string" ? [raw] : [...raw];
  return parts
    .map((p) => normalizeText(p ?? ""))
    .filter((p) => p.length > 0)
    .join("\n\n");
}

const SECTION_DIVIDER_RE = /^(?:[-=_*~#\s]{3,}|\[?(?:ocr|caption|image text|attachment)\]?\s*:?)$/i;

const URDU_NUMBER_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chay: 6, cheh: 6,
  saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, terah: 13, chaudah: 14,
  pandrah: 15, solah: 16, satrah: 17, atharah: 18, unnees: 19, bees: 20, pachees: 25,
  tees: 30, chalis: 40, pachas: 50, saath: 60, sattar: 70, assi: 80, nabbe: 90,
  sau: 100, dedh: 1.5, dhai: 2.5,
};

/**
 * Roman Urdu amounts: "pachas hazar" -> 50000, "20 hazar" -> 20000, "5 sau" -> 500,
 * "do lakh" -> 2 lakh. Number words are only converted when a multiplier follows,
 * so words like "do" (give) elsewhere in a sentence are left alone.
 */
export function normalizeUrduNumbers(input: string): string {
  const words = Object.keys(URDU_NUMBER_WORDS).join("|");
  const num = String.raw`(\d+(?:\.\d+)?|${words})`;
  const toNum = (t: string) => (/^\d/.test(t) ? Number.parseFloat(t) : URDU_NUMBER_WORDS[t.toLowerCase()]);
  return input
    .replace(new RegExp(String.raw`\b${num}\s*(?:hazar|hazaar|hajar)\b`, "gi"), (_m, n: string) => String(Math.round(toNum(n) * 1000)))
    .replace(new RegExp(String.raw`\b${num}\s*sau\b`, "gi"), (_m, n: string) => String(Math.round(toNum(n) * 100)))
    .replace(new RegExp(String.raw`\b(${words})\s*(lakh|lac|lacs|crore|karor)\b`, "gi"), (_m, n: string, u: string) => `${URDU_NUMBER_WORDS[n.toLowerCase()]} ${u}`);
}

export function parseLedgerText(
  raw: string | ReadonlyArray<string | null | undefined>,
  options: ParseOptions = {},
): ParsedDraft {
  // Drop divider/heading lines like "----" or "[OCR]" that callers use when
  // concatenating caption + OCR text.
  const text = normalizeUrduNumbers(
    normalizeText(
      combineSections(raw ?? "")
        .split("\n")
        .filter((l) => !SECTION_DIVIDER_RE.test(l.trim()))
        .join("\n"),
    ),
  );
  const now = options.now ?? new Date();
  const notes: string[] = [];

  if (!text) {
    return {
      entryType: null,
      amountMinor: null,
      currency: options.currency ?? null,
      reference: null,
      description: null,
      paymentMode: null,
      items: [],
      occurredAtHint: null,
      occurredAtText: null,
      termDays: null,
      vendorNameGuess: null,
      confidence: 0,
      signals: [],
      notes: ["empty-message"],
    };
  }

  const items = extractItems(text);
  const candidates = extractAmountCandidates(text);
  let amountMinor = chooseAmount(candidates);
  // No "total" word found (only prices / loose numbers): use the number that is the sum of the lines.
  if (Math.max(0, ...candidates.map((c) => c.weight)) < 90) {
    const columnTotal = totalFromColumnSum(text);
    if (columnTotal) {
      amountMinor = columnTotal;
      notes.push("amount-from-column-sum");
    }
  }

  if (items.length > 0) {
    const itemsSum = items.reduce((acc, i) => acc + (i.lineTotalMinor ?? 0), 0);
    // "saria 2 bundle 127000" -> the only number found is a unit price, so the
    // ledger amount must be qty × rate instead of the raw number.
    const qtyHint = items.some(
      (i) => i.qty > 1 && i.unitPriceMinor !== null && i.unitPriceMinor === amountMinor,
    );
    if (amountMinor === null && itemsSum > 0) {
      amountMinor = itemsSum;
      notes.push("amount-from-line-items");
    } else if (qtyHint && itemsSum > 0) {
      amountMinor = itemsSum;
      notes.push("amount-from-line-items");
    }
    if (amountMinor !== null && itemsSum > 0 && itemsSum !== amountMinor) {
      notes.push("items-sum-differs-from-total");
    }
  }

  const { entryType, signals } = classifyEntryType(text);
  if (amountMinor === null) notes.push("no-amount-found");
  if (entryType === null) notes.push("no-direction-found");

  const reference = extractReference(text);
  const occurred = extractOccurredAt(text, now);
  const termDays = extractTermDays(text, now);
  const vendorNameGuess = guessVendorName(text, options.senderName);
  const paymentMode = extractPaymentMode(text);

  let confidence = 0;
  if (amountMinor !== null) confidence += 42;
  if (entryType !== null) confidence += 30;
  if (items.length > 0) confidence += 14;
  if (reference) confidence += 8;
  if (occurred.date) confidence += 3;
  if (vendorNameGuess) confidence += 3;
  confidence = Math.min(98, confidence);

  const firstLine = text.split("\n").find((l) => l.trim().length > 0)?.slice(0, 160) ?? null;

  return {
    entryType,
    amountMinor,
    currency: options.currency ?? null,
    reference,
    description: firstLine,
    paymentMode,
    items,
    occurredAtHint: occurred.date,
    occurredAtText: occurred.text,
    termDays,
    vendorNameGuess,
    confidence,
    signals,
    notes,
  };
}

/** Human readable WhatsApp confirmation / reply draft. */
export function buildConfirmationText(params: {
  businessName: string;
  vendorName: string;
  entryType: EntryType;
  amountMinor: number;
  currency: string;
  reference?: string | null;
  balanceMinor: number;
  items?: ParsedItem[];
}): string {
  const { businessName, vendorName, entryType, amountMinor, currency, reference, balanceMinor } = params;
  const verb =
    entryType === "credit" ? "Credited (billed)" : "Debited (payment received)";
  const lines = [
    `${businessName}: Entry recorded ✅`,
    `Vendor: ${vendorName}`,
    `${verb}: ${toMinorDisplay(amountMinor, currency)}${reference ? ` • Ref #${reference}` : ""}`,
  ];
  if (params.items?.length) {
    lines.push("Items:");
    for (const item of params.items.slice(0, 8)) {
      lines.push(
        `• ${item.qty}${item.unit ? ` ${item.unit}` : ""} ${item.name}${item.unitPriceMinor ? ` @ ${toMinorDisplay(item.unitPriceMinor, currency)}` : ""}`,
      );
    }
  }
  lines.push(`Running balance: ${toMinorDisplay(balanceMinor, currency)}`);
  lines.push("Reply CORRECT to confirm or EDIT with changes.");
  return lines.join("\n");
}

function toMinorDisplay(minor: number, currency: string): string {
  const whole = Math.floor(Math.abs(minor) / 100);
  const frac = Math.abs(minor) % 100;
  const decimals = frac ? `.${frac.toString().padStart(2, "0")}` : "";
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = minor < 0 ? "-" : "";
  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : "Rs";
  return `${sign}${symbol}${grouped}${decimals}`;
}
