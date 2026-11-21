import { toMinor } from "./money";

const CURRENCIES = new Set(["PKR", "INR", "USD", "AED", "SAR", "BDT", "LKR", "GBP", "EUR", "QAR", "KWD", "OMR", "NPR"]);

export type VendorInput = {
  name?: string;
  phone?: string | null;
  businessType?: string | null;
  city?: string | null;
  currency?: string;
  creditTermsDays?: number;
  openingBalanceMinor?: number;
  kind?: "vendor" | "customer";
};

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * Validate vendor fields from the form / API. `partial` = only fields present are checked (PATCH).
 * Returns a friendly error, or the cleaned values ready for the database.
 */
export function cleanVendorInput(
  body: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): { error: string } | { values: VendorInput } {
  const values: VendorInput = {};
  const has = (k: string) => body[k] !== undefined;

  if (!opts.partial || has("name")) {
    const name = clean(body.name, 200);
    if (name.length < 2) return { error: "Enter the vendor or shop name." };
    if (name.length > 80) return { error: "Vendor name is too long (80 characters at most)." };
    values.name = name;
  }

  if (has("phone")) {
    const raw = String(body.phone ?? "").trim();
    if (!raw) values.phone = null;
    else {
      const digits = raw.replace(/[\s()+-]/g, "");
      if (!/^\d{9,15}$/.test(digits)) return { error: "Phone must be digits with country code, like 923211234501." };
      values.phone = digits;
    }
  }

  if (has("businessType")) values.businessType = clean(body.businessType, 60) || null;
  if (has("city")) values.city = clean(body.city, 60) || null;

  if (has("currency")) {
    const cur = String(body.currency ?? "").trim().toUpperCase();
    if (!CURRENCIES.has(cur)) return { error: "Choose a currency from the list." };
    values.currency = cur;
  }

  if (has("creditTermsDays")) {
    const n = Number(body.creditTermsDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) return { error: "Credit terms must be a whole number of days from 0 to 365." };
    values.creditTermsDays = n;
  }

  if (has("openingBalance")) {
    const raw = String(body.openingBalance ?? "").trim().replace(/,/g, "");
    if (raw === "") values.openingBalanceMinor = 0;
    else {
      if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) return { error: "Opening balance must be a number like 5000 or 1250.50." };
      const minor = toMinor(raw.replace("-", ""));
      if (minor > 100_000_000_000_00) return { error: "Opening balance is too large. Check the zeros." };
      values.openingBalanceMinor = raw.startsWith("-") ? -minor : minor;
    }
  }
  if (has("kind")) {
    const kind = String(body.kind ?? "").trim().toLowerCase();
    if (kind !== "vendor" && kind !== "customer") return { error: "Type must be vendor or customer." };
    values.kind = kind;
  }
  return { values };
}
