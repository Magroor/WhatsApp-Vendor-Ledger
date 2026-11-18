import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, reminders, reportSnapshots, syncQueue, transactions, txItems, vendors, waMessages } from "@/db/schema";
import { postParsedDraft } from "./ingest";
import { parseLedgerText } from "./parse";
import { getSettings } from "./settings";

/** Deterministic PRNG so demo data is reproducible between runs. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const VENDOR_SEEDS: Array<{
  name: string;
  phone: string;
  businessType: string;
  city: string;
  currency: string;
  terms: number;
  opening: number;
  bills: string[];
  payments: string[];
}> = [
  {
    name: "Ahmed Traders",
    phone: "923211234501",
    businessType: "Hardware distributor",
    city: "Lahore",
    currency: "PKR",
    terms: 30,
    opening: 0,
    bills: [
      "Ahmed Traders\nBill #1042 - 12 Feb\n5 bags cement @ 1480\n3 boxes fittings @ 900\nTotal 10100 udhaar",
      "Bill #1077\n8 bags cement @ 1500\nTotal 12000 on credit, due in 30 days",
      "Udhaar supply for shop\n6 kg screws @ 420\n2 packs anchors @ 650\nTotal Rs 3820",
      "Invoice #1190 dated 14/03\n4 boxes hinges @ 1150\nTotal 4600 credit",
      "Bill #1240\n10 bags cement @ 1520\n2 boxes hinges @ 1150\nGrand total 17500 udhaar",
    ],
    payments: [
      "Payment received via easypaisa Rs 8000 against bill #1042",
      "Paid 12000 by bank transfer today, bill #1077 settled",
      "Cash paid Rs 5000 to Ahmed Traders jama",
    ],
  },
  {
    name: "Bilal Steel & Cement",
    phone: "923334455602",
    businessType: "Steel supplier",
    city: "Faisalabad",
    currency: "PKR",
    terms: 45,
    opening: 250000,
    bills: [
      "Bilal Steel\nChallan #A-229\n10 saria bundles @ 128000\nTotal 128000 udhaar",
      "Bill #A-231 8 mm saria 5 bundles @ 126500\nTotal Rs 632500 credit",
      "Supply 3 bundles saria @ 127000\nTotal 381000, net 45 days",
      "Invoice #A-240\n2 bundles saria @ 129000\nTotal 258000 udhaar",
    ],
    payments: [
      "Jama 300000 cheque no 55621 deposited",
      "Payment of 250000 sent by bank transfer yesterday",
    ],
  },
  {
    name: "Chaudhry Karyana Store",
    phone: "923001234503",
    businessType: "Grocery wholesaler",
    city: "Lahore",
    currency: "PKR",
    terms: 15,
    opening: 0,
    bills: [
      "CKS bill #551\n25 kg sugar @ 178\n10 kg rice @ 340\nTotal 7850 udhaar",
      "Bill #563\n15 kg flour @ 165\n6 cartons soap @ 1250\nTotal Rs 9975 credit",
      "Aaj ka bill #570\n8 kg tea @ 2100\nTotal 16800",
    ],
    payments: ["Paid 7850 cash today", "Easypaisa payment Rs 9975 sent"],
  },
  {
    name: "Delta Paints",
    phone: "923456789004",
    businessType: "Paints & chemicals",
    city: "Karachi",
    currency: "PKR",
    terms: 30,
    opening: 0,
    bills: [
      "Delta Paints Invoice #IN-9081\n12 gallons emulsion @ 8400\n3 gallons primer @ 5200\nTotal 116400 credit",
      "Bill #IN-9120\n5 gallons enamel @ 9100\nTotal 45500 udhaar",
    ],
    payments: ["Payment 60000 transferred via bank, invoice IN-9081"],
  },
  {
    name: "Farhan Electric Supplies",
    phone: "923219988775",
    businessType: "Electricals",
    city: "Rawalpindi",
    currency: "PKR",
    terms: 21,
    opening: 0,
    bills: [
      "Farhan Electric\nBill #E-774\n40 pcs LED bulb 18w @ 460\nTotal 18400 udhaar",
      "Bill #E-788 15 pcs switch board @ 850\nTotal Rs 12750 on credit",
    ],
    payments: ["Cash paid 10000, remaining ajust ho jayega"],
  },
];

export async function seedDemoData(force = false): Promise<{
  seeded: boolean;
  vendors: number;
  transactions: number;
}> {
  const existing = await db.select({ count: sql<number>`count(*)::int` }).from(vendors);
  if ((existing[0]?.count ?? 0) > 0 && !force) {
    return { seeded: false, vendors: existing[0]?.count ?? 0, transactions: 0 };
  }

  if (force) {
    await db.delete(txItems);
    await db.delete(transactions);
    await db.delete(reminders);
    await db.delete(reportSnapshots);
    await db.delete(waMessages);
    await db.delete(auditEvents);
    await db.delete(syncQueue);
    await db.delete(vendors);
  }

  const settings = await getSettings();
  const random = rng(20260214);
  const now = new Date();
  let txCount = 0;

  for (const seed of VENDOR_SEEDS) {
    const inserted = await db
      .insert(vendors)
      .values({
        name: seed.name,
        phone: seed.phone,
        businessType: seed.businessType,
        city: seed.city,
        currency: seed.currency,
        creditTermsDays: seed.terms,
        openingBalanceMinor: seed.opening,
        autoCreateSource: "seed",
        notes: `Demo ${seed.businessType} in ${seed.city}`,
      })
      .returning();
    const vendor = inserted[0];

    const allTexts = [...seed.bills, ...seed.payments];
    const spanDays = 330;
    for (let i = 0; i < allTexts.length; i += 1) {
      const text = allTexts[i];
      const daysAgo = Math.round(
        spanDays - (i / Math.max(1, allTexts.length - 1)) * spanDays + random() * 6,
      );
      const receivedAt = new Date(now.getTime() - Math.max(1, daysAgo) * 86400000);
      receivedAt.setHours(9 + Math.floor(random() * 9), Math.floor(random() * 59), 0, 0);

      const draft = parseLedgerText(text, {
        currency: seed.currency,
        now: receivedAt,
        defaultTermDays: seed.terms,
        senderName: seed.name,
      });

      const waId = `seed-${vendor.id}-${i}`;
      const messageRow = await db
        .insert(waMessages)
        .values({
          waMessageId: waId,
          vendorId: vendor.id,
          direction: "in",
          messageType: "text",
          body: text,
          fromPhone: seed.phone,
          profileName: seed.name,
          receivedAt,
          parseStatus: draft.amountMinor && draft.entryType ? "parsed" : "review",
          parseConfidence: draft.confidence,
          extractionSource: "rules",
          parsePayload: draft as never,
        })
        .returning();

      if (!draft.entryType || draft.amountMinor === null) continue;

      const tx = await postParsedDraft({
        draft,
        vendorId: vendor.id,
        currency: seed.currency,
        defaultTermDays: seed.terms,
        autoConfirmThreshold: settings.autoConfirmThreshold,
        messageId: messageRow[0].id,
        occurredAtFallback: receivedAt,
        actor: "seed",
      });
      if (tx) txCount += 1;
    }
  }

  return { seeded: true, vendors: VENDOR_SEEDS.length, transactions: txCount };
}
