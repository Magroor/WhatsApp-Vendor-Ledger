import crypto from "node:crypto";
import { fail, ok, readJsonObject } from "@/lib/api";
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

function isCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      return supported("currency").includes(code);
    } catch {
      /* fall through */
    }
  }
  return true;
}

function intInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Every supplied known key is validated; any bad value rejects the whole
 * request with 400 (nothing is saved). Unknown keys are ignored.
 */
export async function POST(req: Request) {
  const read = await readJsonObject<Record<string, unknown>>(req, 64 * 1024);
  if (!read.ok) return fail(read.error, read.status);
  const body = read.body as { [K in keyof PatchBody]?: unknown };
  const patch: Partial<AppSettingsShape> = {};
  const errors: string[] = [];

  if (body.businessName !== undefined) {
    const name = typeof body.businessName === "string" ? body.businessName.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (!name) errors.push("businessName cannot be empty");
    else if (name.length > 80) errors.push("businessName must be at most 80 characters");
    else patch.businessName = name;
  }
  if (body.currency !== undefined) {
    const code = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
    if (!isCurrencyCode(code)) errors.push("currency must be a 3-letter ISO code like PKR");
    else patch.currency = code;
  }
  const ints: Array<[keyof AppSettingsShape, number, number]> = [
    ["defaultTermDays", 0, 365],
    ["autoConfirmThreshold", 0, 100],
    ["reminderCadenceDays", 1, 90],
    ["weeklyReportDay", 0, 6],
  ];
  for (const [key, min, max] of ints) {
    if (body[key] === undefined) continue;
    const n = intInRange(body[key], min, max);
    if (n === null) errors.push(`${key} must be a whole number from ${min} to ${max}`);
    else (patch as Record<string, unknown>)[key] = n;
  }
  if (body.autoReply !== undefined) {
    if (typeof body.autoReply !== "boolean") errors.push("autoReply must be true or false");
    else patch.autoReply = body.autoReply;
  }
  if (body.timeZone !== undefined) {
    let valid = false;
    if (typeof body.timeZone === "string" && body.timeZone.trim() && body.timeZone.length <= 64) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timeZone.trim() });
        valid = true;
      } catch {
        valid = false;
      }
    }
    if (!valid) errors.push("timeZone must be an IANA zone like Asia/Karachi");
    else patch.timeZone = (body.timeZone as string).trim();
  }
  for (const key of ["whatsappPhoneNumberId", "whatsappBusinessId"] as const) {
    if (body[key] === undefined) continue;
    const v = typeof body[key] === "string" ? (body[key] as string).replace(/\s+/g, "") : null;
    if (v === null || !/^\d{0,32}$/.test(v)) errors.push(`${key} must be digits only`);
    else patch[key] = v;
  }
  if (typeof body.webhookVerifyToken === "string" && body.webhookVerifyToken.trim()) {
    const token = body.webhookVerifyToken.trim();
    if (!/^[\x21-\x7e]{4,128}$/.test(token)) {
      errors.push("webhookVerifyToken must be 4-128 visible characters with no spaces");
    } else patch.webhookVerifyToken = token;
  } else if (body.webhookVerifyToken !== undefined && typeof body.webhookVerifyToken !== "string") {
    errors.push("webhookVerifyToken must be a string");
  } else if (body.rotateVerifyToken === true) {
    patch.webhookVerifyToken = `vrf_${crypto.randomBytes(12).toString("base64url")}`;
  }

  if (errors.length) return fail(errors.join("; "), 400, { errors });
  const next = await saveSettings(patch);
  return ok({ settings: next, config: configSummary() });
}
