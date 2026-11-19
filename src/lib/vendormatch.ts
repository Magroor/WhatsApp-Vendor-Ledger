import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { findVendorByPhone } from "./ingest";

export const UNASSIGNED_VENDOR = "Unassigned (choose vendor)";

/** Pick an existing vendor whose name appears in the given text (caption, OCR text, chat title). */
export async function matchVendorByText(text: string): Promise<number | null> {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  const rows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(eq(vendors.archived, false));
  const full = rows.filter((v) => v.name.length >= 3 && t.includes(v.name.toLowerCase()));
  if (full.length === 1) return full[0].id;
  const byToken = rows.filter((v) => {
    const first = (v.name.toLowerCase().split(/\s+/)[0] ?? "").replace(/[^a-z0-9]/g, "");
    return first.length >= 4 && new RegExp(`\\b${first}\\b`).test(t);
  });
  return byToken.length === 1 ? byToken[0].id : null;
}

/** A chat title is either a saved contact name or a bare phone number. */
export async function matchVendorByChatTitle(title: string | null): Promise<number | null> {
  if (!title) return null;
  const digits = title.replace(/\D/g, "");
  if (digits.length >= 9) {
    const byPhone = await findVendorByPhone(digits);
    if (byPhone) return byPhone.id;
  }
  return matchVendorByText(title);
}

export async function getUnassignedVendorId(currency: string): Promise<number> {
  const found = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.name, UNASSIGNED_VENDOR)).limit(1);
  if (found[0]) return found[0].id;
  const created = await db
    .insert(vendors)
    .values({ name: UNASSIGNED_VENDOR, currency, autoCreateSource: "capture", needsReview: true })
    .returning({ id: vendors.id });
  return created[0].id;
}
