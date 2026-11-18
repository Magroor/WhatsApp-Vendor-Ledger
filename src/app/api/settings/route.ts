import { ok, readJson } from "@/lib/api";
import { getSettings, saveSettings, type AppSettingsShape } from "@/lib/settings";
import { whatsappConfigured } from "@/lib/wa";

export const dynamic = "force-dynamic";

function configSummary() {
  const secretFlags = {
    whatsappToken: Boolean(process.env.WHATSAPP_TOKEN),
    whatsappAppSecret: Boolean(process.env.WHATSAPP_APP_SECRET),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  };
  return {
    ...secretFlags,
    liveMode: whatsappConfigured(),
    // Never expose raw secrets — presence flags only.
    tokenFingerprint: process.env.WHATSAPP_TOKEN
      ? `${process.env.WHATSAPP_TOKEN.slice(0, 4)}…${process.env.WHATSAPP_TOKEN.slice(-4)}`
      : null,
  };
}

export async function GET(req: Request) {
  const settings = await getSettings();
  const origin = new URL(req.url).origin;
  return ok({
    settings,
    config: configSummary(),
    webhookUrl: `${origin}/api/webhook/whatsapp`,
    webhookVerifyUrl: `${origin}/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
      settings.webhookVerifyToken,
    )}&hub.challenge=ping`,
  });
}

type PatchBody = Partial<AppSettingsShape> & { rotateVerifyToken?: boolean };

export async function POST(req: Request) {
  const body = await readJson<PatchBody>(req);
  const patch: Partial<AppSettingsShape> = {};
  if (typeof body.businessName === "string" && body.businessName.trim()) patch.businessName = body.businessName.trim().slice(0, 80);
  if (typeof body.currency === "string") patch.currency = body.currency.toUpperCase().slice(0, 3);
  if (typeof body.defaultTermDays === "number") patch.defaultTermDays = Math.max(0, Math.min(365, body.defaultTermDays));
  if (typeof body.autoReply === "boolean") patch.autoReply = body.autoReply;
  if (typeof body.autoConfirmThreshold === "number") {
    patch.autoConfirmThreshold = Math.max(0, Math.min(100, Math.round(body.autoConfirmThreshold)));
  }
  if (typeof body.reminderCadenceDays === "number") patch.reminderCadenceDays = Math.max(1, Math.min(90, body.reminderCadenceDays));
  if (typeof body.weeklyReportDay === "number") patch.weeklyReportDay = Math.max(0, Math.min(6, body.weeklyReportDay));
  if (typeof body.timeZone === "string") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timeZone });
      patch.timeZone = body.timeZone;
    } catch {
      /* ignore invalid zone */
    }
  }
  if (typeof body.whatsappPhoneNumberId === "string") patch.whatsappPhoneNumberId = body.whatsappPhoneNumberId.trim();
  if (typeof body.whatsappBusinessId === "string") patch.whatsappBusinessId = body.whatsappBusinessId.trim();
  if (typeof body.webhookVerifyToken === "string" && body.webhookVerifyToken.trim()) {
    patch.webhookVerifyToken = body.webhookVerifyToken.trim();
  } else if (body.rotateVerifyToken) {
    patch.webhookVerifyToken = `vrf_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;
  }

  const next = await saveSettings(patch);
  return ok({ settings: next, config: configSummary() });
}
