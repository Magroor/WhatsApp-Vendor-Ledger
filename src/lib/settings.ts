import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, auditEvents } from "@/db/schema";

export type AppSettingsShape = {
  businessName: string;
  currency: string;
  defaultTermDays: number;
  autoReply: boolean;
  autoConfirmThreshold: number;
  reminderCadenceDays: number;
  weeklyReportDay: number; // 1 = Monday
  whatsappPhoneNumberId: string;
  whatsappBusinessId: string;
  webhookVerifyToken: string;
  timeZone?: string; // IANA name, e.g. Asia/Karachi
};

export const DEFAULT_SETTINGS: AppSettingsShape = {
  businessName: "My Shop",
  currency: "PKR",
  defaultTermDays: 30,
  autoReply: true,
  autoConfirmThreshold: 75,
  reminderCadenceDays: 7,
  weeklyReportDay: 1,
  whatsappPhoneNumberId: "",
  whatsappBusinessId: "",
  webhookVerifyToken: "vendor-ledger-verify",
};

const SETTINGS_KEY = "app";

export async function getSettings(): Promise<AppSettingsShape> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, SETTINGS_KEY))
    .limit(1);
  const stored = (rows[0]?.value ?? {}) as Partial<AppSettingsShape>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(
  patch: Partial<AppSettingsShape>,
): Promise<AppSettingsShape> {
  const current = await getSettings();
  const next: AppSettingsShape = { ...current, ...patch };
  await db
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updatedAt: new Date() },
    });
  return next;
}

export async function logAudit(event: {
  entityType: string;
  entityId?: number | null;
  action: string;
  actor?: string;
  summary?: string;
  payload?: unknown;
}): Promise<void> {
  await db.insert(auditEvents).values({
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    action: event.action,
    actor: event.actor ?? "system",
    summary: event.summary ?? null,
    payload: (event.payload ?? null) as never,
  });
}

export async function countAudit(): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents);
  return rows[0]?.count ?? 0;
}
