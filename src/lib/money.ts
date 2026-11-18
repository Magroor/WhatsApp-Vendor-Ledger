/**
 * Deterministic money helpers. Everything is integer minor units (paisa/cents)
 * so ledger maths is exact — no floating point accumulation errors.
 */

export const MINOR = 100;

const CURRENCY_SYMBOLS: Record<string, string> = {
  PKR: "Rs",
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AED: "AED",
  SAR: "SAR",
  BDT: "৳",
  LKR: "Rs",
  NPR: "Rs",
  KWD: "KD",
  QAR: "QR",
  OMR: "OMR",
};

export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency?.toUpperCase()] ?? `${currency} `;
}

/** Parse a human money string ("15,000.50", "Rs 1.2k", "2 lakh") into minor units. */
export function toMinor(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === "number") return Math.round(input * MINOR);
  // Strip grouping, whitespace and currency markers so only "<number><suffix?>" remains.
  let body = input
    .replace(/[,\s₹$]/g, "")
    .replace(/^(?:rs\.?|pkr|inr|usd|aed|sar|rupees)/i, "")
    .replace(/(?:\/-|-?rs\.?|pkr|inr|rupees)$/i, "");
  const negative = body.startsWith("-");
  if (negative) body = body.slice(1);
  const sign = negative ? -1 : 1;
  const m = body.match(/^(\d+(?:\.\d+)?|\.\d+)(k|thousand|lakhs?|lacs?|crores?|cr)?$/i);
  if (!m) {
    // Fallback for loose input: first well-formed number in the string.
    const loose = body.match(/\d+(?:\.\d+)?/);
    if (!loose) return 0;
    const v = parseFloat(loose[0]);
    return Number.isFinite(v) ? sign * Math.round(v * MINOR) : 0;
  }
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const suffix = (m[2] ?? "").toLowerCase();
  let multiplier = 1;
  if (suffix === "k" || suffix === "thousand") multiplier = 1000;
  else if (suffix.startsWith("lakh") || suffix.startsWith("lac")) multiplier = 100000;
  else if (suffix.startsWith("cr")) multiplier = 10000000;
  return sign * Math.round(value * multiplier * MINOR);
}

/** Minor units -> plain decimal number (for forms / CSV). */
export function minorToNumber(minor: number | null | undefined): number {
  return Math.round((minor ?? 0) * 100) / 100;
}

/** Grouped integer part, fixed 2 decimals when paise exist. */
function groupDigits(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatMinor(
  minor: number | null | undefined,
  currency = "PKR",
  opts: { decimals?: boolean; sign?: boolean } = {},
): string {
  const value = minor ?? 0;
  const negative = value < 0;
  const abs = Math.abs(value);
  const decimals = opts.decimals ?? abs % MINOR !== 0;
  const whole = Math.floor(abs / MINOR);
  const frac = abs % MINOR;
  const decimalsStr = decimals
    ? `.${frac.toString().padStart(2, "0")}`
    : "";
  const prefix = negative ? "-" : opts.sign ? "+" : "";
  return `${prefix}${currencySymbol(currency)}${groupDigits(String(whole))}${decimalsStr}`;
}

export function signedFormatMinor(
  minor: number,
  currency = "PKR",
): string {
  if (minor > 0) return `+${formatMinor(minor, currency)}`;
  return formatMinor(minor, currency);
}

export function sumMinor(values: Array<number | null | undefined>): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

/** Safe percentage share (0 when denominator 0). */
export function shareOf(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}
