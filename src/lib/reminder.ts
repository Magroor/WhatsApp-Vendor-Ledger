import { normalizeKind, type PartyKind } from "./kind";
import { formatMinor } from "./money";

export type ReminderParams = {
  businessName: string;
  vendorName: string;
  balanceMinor: number;
  currency: string;
  oldestAgeDays: number;
  termsDays: number;
};

/** Vendor reminder (unchanged wording): the shop's own payable summary. */
export function buildReminderText(params: ReminderParams): string {
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

/** Customer reminder: a polite payment request in simple English with a Roman Urdu greeting. */
export function buildCustomerReminderText(params: Pick<ReminderParams, "businessName" | "vendorName" | "balanceMinor" | "currency">): string {
  const amount = formatMinor(Math.max(0, params.balanceMinor), params.currency);
  return [
    `Assalam o Alaikum, ${params.vendorName}.`,
    `Your balance with ${params.businessName} is ${amount}.`,
    "Please send payment when convenient. Shukriya.",
  ].join("\n");
}

/** Picks the right reminder wording for the party kind. */
export function buildPartyReminderText(kind: PartyKind | string | null | undefined, params: ReminderParams): string {
  return normalizeKind(kind) === "customer" ? buildCustomerReminderText(params) : buildReminderText(params);
}
