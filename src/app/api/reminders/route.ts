import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { reminders, transactions, vendors } from "@/db/schema";
import { fail, ok, parseId, readJson } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { loadLedgerRows, computeOpenLots } from "@/lib/reports";
import { getSettings, logAudit } from "@/lib/settings";
import { sendWhatsAppText, waDeepLink } from "@/lib/wa";

export const dynamic = "force-dynamic";

export function buildReminderText(params: {
  businessName: string;
  vendorName: string;
  balanceMinor: number;
  currency: string;
  oldestAgeDays: number;
  termsDays: number;
}): string {
  const lines = [
    `${params.businessName} — payment reminder 🧾`,
    `Vendor: ${params.vendorName}`,
    `Outstanding balance: ${formatMinor(params.balanceMinor, params.currency)}`,
  ];
  if (params.oldestAgeDays > params.termsDays) {
    lines.push(
      `Oldest open bill is ${params.oldestAgeDays} days old (terms: Net-${params.termsDays}).`,
    );
  }
  lines.push("Kindly clear the pending amount. Reply with a screenshot once paid.");
  return lines.join("\n");
}

export async function GET() {
  const settings = await getSettings();
  const rows = await loadLedgerRows({ statuses: ["confirmed"] });
  const lots = computeOpenLots(rows, new Date());
  const grouped = new Map<
    number,
    { vendorId: number; vendorName: string; phone: string | null; currency: string; amountMinor: number; oldestAgeDays: number; openLots: number }
  >();
  for (const lot of lots) {
    const entry =
      grouped.get(lot.vendorId) ??
      {
        vendorId: lot.vendorId,
        vendorName: lot.vendorName,
        phone: null,
        currency: lot.currency,
        amountMinor: 0,
        oldestAgeDays: 0,
        openLots: 0,
      };
    entry.amountMinor += lot.remainingMinor;
    entry.oldestAgeDays = Math.max(entry.oldestAgeDays, lot.ageDays);
    entry.openLots += 1;
    grouped.set(lot.vendorId, entry);
  }
  const vendorRows = await db
    .select({ id: vendors.id, phone: vendors.phone, terms: vendors.creditTermsDays })
    .from(vendors);

  const list = [...grouped.values()]
    .map((g) => {
      const v = vendorRows.find((x) => x.id === g.vendorId);
      return {
        ...g,
        phone: v?.phone ?? null,
        termsDays: v?.terms ?? settings.defaultTermDays,
        overdueDays: Math.max(0, g.oldestAgeDays - (v?.terms ?? settings.defaultTermDays)),
      };
    })
    .sort((a, b) => b.amountMinor - a.amountMinor);

  const history = await db
    .select({
      id: reminders.id,
      vendorId: reminders.vendorId,
      vendorName: vendors.name,
      amountMinor: reminders.amountMinor,
      status: reminders.status,
      messageText: reminders.messageText,
      sentAt: reminders.sentAt,
      createdAt: reminders.createdAt,
    })
    .from(reminders)
    .innerJoin(vendors, eq(vendors.id, reminders.vendorId))
    .orderBy(desc(reminders.createdAt))
    .limit(25);

  return ok({
    due: list,
    history: history.map((h) => ({ ...h, amountMinor: Number(h.amountMinor) })),
  });
}

export async function POST(req: Request) {
  const body = await readJson<{ vendorId?: number; transactionId?: number; note?: string }>(req);
  const vendorId = body.vendorId ?? parseId(body.vendorId as unknown as string);
  if (!vendorId) return fail("vendorId required");

  const vendorRows = await db
    .select()
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  const vendor = vendorRows[0];
  if (!vendor) return fail("vendor not found", 404);

  const settings = await getSettings();
  const rows = await loadLedgerRows({ vendorId, statuses: ["confirmed"] });
  const lots = computeOpenLots(rows, new Date());
  const balanceMinor = lots.reduce((a, l) => a + l.remainingMinor, 0);
  const oldestAgeDays = lots.reduce((a, l) => Math.max(a, l.ageDays), 0);
  const messageText = buildReminderText({
    businessName: settings.businessName,
    vendorName: vendor.name,
    balanceMinor,
    currency: vendor.currency,
    oldestAgeDays,
    termsDays: vendor.creditTermsDays,
  });

  const sent = vendor.phone ? await sendWhatsAppText(vendor.phone, messageText) : { sent: false, simulated: true };

  const inserted = await db
    .insert(reminders)
    .values({
      vendorId,
      transactionId: body.transactionId ?? null,
      amountMinor: balanceMinor,
      dueDate: sql`(current_date + ${vendor.creditTermsDays} * interval '1 day')::date` as never,
      channel: "whatsapp",
      status: sent.sent ? "sent" : sent.simulated ? "simulated" : "failed",
      messageText,
      sentAt: sent.sent ? new Date() : null,
    })
    .returning();

  await logAudit({
    entityType: "reminder",
    entityId: inserted[0].id,
    action: sent.sent ? "reminder.sent" : "reminder.queued",
    actor: "user",
    summary: `Reminder for ${vendor.name}: ${formatMinor(balanceMinor, vendor.currency)}`,
  });

  const openLots = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.vendorId, vendorId), eq(transactions.status, "confirmed")))
    .limit(1);

  return ok(
    {
      reminder: inserted[0],
      balanceMinor,
      oldestAgeDays,
      delivered: sent.sent,
      simulated: sent.simulated,
      whatsappLink: waDeepLink(vendor.phone, messageText),
      linkedTransactionId: openLots[0]?.id ?? null,
    },
    201,
  );
}
