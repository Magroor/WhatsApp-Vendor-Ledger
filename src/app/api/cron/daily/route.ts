import crypto from "node:crypto";
import { clientKey, fail, ok, rateLimit } from "@/lib/api";
import { getPayPlan } from "@/lib/planner";
import { buildDuePayload, buildWeeklyPayload, pushConfigured, sendPushToAll } from "@/lib/push";
import { loadLedgerRows, summarize } from "@/lib/reports";
import { getSettings } from "@/lib/settings";
import { civilOf, civilWeekday, resolveTimeZone } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Who may run the daily job (this route is public in src/proxy.ts and checks itself):
 *  - `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set (Vercel Cron sends this
 *    automatically once CRON_SECRET is defined in the project), or
 *  - Vercel's cron header / user agent, but ONLY on Vercel and only while CRON_SECRET is unset
 *    (those headers can be forged by anyone, so set CRON_SECRET in production).
 */
function cronAuthorized(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (secret) {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    return Boolean(bearer) && safeEqual(bearer, secret);
  }
  if (!process.env.VERCEL) return false;
  const ua = req.headers.get("user-agent") ?? "";
  return req.headers.has("x-vercel-cron") || /vercel-cron/i.test(ua);
}

/** Daily: "payments due" digest, and on the weekly report day a weekly summary. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return fail("unauthorized", 401);
  if (!rateLimit(clientKey(req, "cron-daily"), 10, 60_000)) return fail("rate-limited", 429);
  if (!pushConfigured()) return ok({ ok: true, configured: false, due: null, weekly: null });

  const settings = await getSettings();
  const tz = resolveTimeZone(settings.timeZone);
  const now = new Date();
  const plan = await getPayPlan();

  const duePayload = buildDuePayload(plan);
  const due = duePayload ? await sendPushToAll("dueSoon", duePayload) : null;

  // weeklyReportDay uses JS numbering (0 = Sunday, 1 = Monday); civilWeekday is 0 = Monday.
  const todayJs = (civilWeekday(civilOf(now, tz)) + 1) % 7;
  let weekly = null;
  if (todayJs === settings.weeklyReportDay) {
    const rows = await loadLedgerRows({ statuses: ["confirmed"], start: new Date(now.getTime() - 7 * 86_400_000), endExclusive: now });
    const s = summarize(rows);
    weekly = await sendPushToAll(
      "weekly",
      buildWeeklyPayload({
        currency: rows[0]?.currency ?? plan.currency ?? settings.currency,
        creditMinor: s.creditMinor,
        debitMinor: s.debitMinor,
        creditCount: s.creditCount,
        debitCount: s.debitCount,
        dueNowMinor: plan.neededThisWeekMinor,
      }),
    );
  }
  return ok({ ok: true, configured: true, due, weekly });
}

export const POST = GET;
