import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { transactions, vendors } from "@/db/schema";
import { cleanVendorInput } from "@/lib/vendor-input";
import { findVendorByPhone } from "@/lib/ingest";
import { clientKey, fail, ok, parseAmountToMinor, rateLimit, readJson } from "@/lib/api";
import { normalizePhone } from "@/lib/wa";
import { logAudit } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();

  const where = q
    ? and(eq(vendors.archived, false), or(ilike(vendors.name, `%${q}%`), ilike(vendors.phone, `%${q}%`)))
    : eq(vendors.archived, false);

  const rows = await db
    .select({
      id: vendors.id,
      name: vendors.name,
      phone: vendors.phone,
      businessType: vendors.businessType,
      city: vendors.city,
      currency: vendors.currency,
      creditTermsDays: vendors.creditTermsDays,
      opening: vendors.openingBalanceMinor,
      needsReview: vendors.needsReview,
      createdAt: vendors.createdAt,
      credit: sql<string>`coalesce(sum(case when ${transactions.entryType} = 'credit' then ${transactions.amountMinor} else 0 end), 0)`,
      debit: sql<string>`coalesce(sum(case when ${transactions.entryType} = 'debit' then ${transactions.amountMinor} else 0 end), 0)`,
      txnCount: sql<number>`count(${transactions.id})::int`,
      lastActivity: sql<string | null>`max(${transactions.occurredAt})`,
    })
    .from(vendors)
    .leftJoin(
      transactions,
      and(eq(transactions.vendorId, vendors.id), eq(transactions.status, "confirmed")),
    )
    .where(where)
    .groupBy(vendors.id)
    .orderBy(vendors.name);

  return ok({
    vendors: rows.map((r) => ({
      ...r,
      creditMinor: Number(r.credit),
      debitMinor: Number(r.debit),
      balanceMinor: Number(r.credit) - Number(r.debit) + Number(r.opening),
    })),
  });
}

type CreateBody = {
  name?: string;
  phone?: string;
  businessType?: string;
  city?: string;
  currency?: string;
  creditTermsDays?: number;
  openingBalance?: string | number;
};

export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "vendor-create"), 40, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<CreateBody>(req);
  const checked = cleanVendorInput(body as Record<string, unknown>);
  if ("error" in checked) return fail(checked.error);
  const v = checked.values;
  const name = v.name as string;
  if (v.phone) {
    const clash = await findVendorByPhone(v.phone);
    if (clash) return fail(`A vendor with this number already exists: ${clash.name}.`, 409);
  }

  const inserted = await db
    .insert(vendors)
    .values({
      name,
      phone: v.phone ?? null,
      businessType: v.businessType ?? null,
      city: v.city ?? null,
      currency: v.currency ?? "PKR",
      creditTermsDays: v.creditTermsDays ?? 30,
      openingBalanceMinor: v.openingBalanceMinor ?? 0,
      autoCreateSource: "manual",
      needsReview: false,
    })
    .returning();

  await logAudit({
    entityType: "vendor",
    entityId: inserted[0].id,
    action: "vendor.created",
    actor: "user",
    summary: `Vendor ${name} created (phone ${normalizePhone(body.phone) ?? "n/a"})`,
  });

  return ok({ vendor: inserted[0] }, 201);
}
