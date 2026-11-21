import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { vendorAliases, vendors, waMessages } from "@/db/schema";

/** Lowercase, drop punctuation/diacritics noise, collapse spaces. Keeps Urdu script. */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, "") // Arabic diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const last10 = (digits: string) => digits.replace(/\D/g, "").slice(-10);

/** Phone-looking numbers in a bill: 0300-1234567, +92 300 1234567, 042-37245855. */
export function phonesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\d])(?:\+?92[\s-]?|0)(?:3\d{2}|\d{2,3})[\s-]?\d{6,8}(?![\d])/g)) {
    const d = last10(m[0]);
    if (d.length === 10) out.add(d);
  }
  return [...out];
}

/** The shop-name header of a bill: the first short, letter-rich line. */
export function headerNameIn(text: string): string | null {
  for (const raw of text.split("\n").slice(0, 6)) {
    const line = raw.replace(/[|]/g, " ").trim();
    if (line.length < 4 || line.length > 48) continue;
    const letters = (line.match(/\p{L}/gu) ?? []).length;
    if (letters < 4 || letters < line.length * 0.6) continue;
    if (/^(bill|invoice|cash memo|date|total|tel|mob|phone|customer|name|no\b|نمبر|تاریخ)/i.test(line)) continue;
    return line;
  }
  return null;
}

/** Remember how this bill names its vendor (header line + phone numbers). Safe to call repeatedly. */
export async function learnAliases(vendorId: number, text: string): Promise<{ learned: string[] }> {
  const learned: string[] = [];
  const own = (await db.select({ name: vendors.name, phone: vendors.phone }).from(vendors).where(eq(vendors.id, vendorId)).limit(1))[0];
  const rows: Array<{ kind: "name" | "phone"; alias: string; aliasNorm: string }> = [];

  const header = headerNameIn(text);
  if (header && normName(header) !== normName(own?.name ?? "")) rows.push({ kind: "name", alias: header, aliasNorm: normName(header) });
  for (const p of phonesIn(text)) if (p !== last10(own?.phone ?? "")) rows.push({ kind: "phone", alias: p, aliasNorm: p });

  for (const r of rows) {
    if (!r.aliasNorm) continue;
    const inserted = await db.insert(vendorAliases).values({ vendorId, ...r }).onConflictDoNothing().returning({ id: vendorAliases.id });
    if (inserted[0]) learned.push(r.alias);
  }
  return { learned };
}

/** Learn from the text of a stored message once a person has chosen its vendor. */
export async function learnFromMessage(messageId: number, vendorId: number) {
  const m = (await db.select().from(waMessages).where(eq(waMessages.id, messageId)).limit(1))[0];
  if (!m) return { learned: [] as string[] };
  const text = [m.ocrText, m.body, m.caption].filter(Boolean).join("\n");
  return text.trim() ? learnAliases(vendorId, text) : { learned: [] as string[] };
}

/** A vendor this text belongs to by a learned alias (phone first: it is the strongest signal). */
export async function findVendorByAlias(text: string): Promise<number | null> {
  const phones = phonesIn(text);
  if (phones.length) {
    const hit = await db.select({ vendorId: vendorAliases.vendorId }).from(vendorAliases).where(and(eq(vendorAliases.kind, "phone"), inArray(vendorAliases.aliasNorm, phones)));
    const ids = [...new Set(hit.map((h) => h.vendorId))];
    if (ids.length === 1) return ids[0];
  }
  const t = normName(text);
  if (!t) return null;
  const names = await db.select({ vendorId: vendorAliases.vendorId, aliasNorm: vendorAliases.aliasNorm }).from(vendorAliases).where(eq(vendorAliases.kind, "name"));
  const ids = [...new Set(names.filter((n) => n.aliasNorm.length >= 4 && t.includes(n.aliasNorm)).map((n) => n.vendorId))];
  return ids.length === 1 ? ids[0] : null;
}

export async function listAliases(vendorId: number) {
  return db.select().from(vendorAliases).where(eq(vendorAliases.vendorId, vendorId));
}
