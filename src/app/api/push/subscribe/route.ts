import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { clientKey, fail, ok, readJson, rateLimit } from "@/lib/api";
import { normalizePrefs, parseSubscription, pushConfigured, type PushPrefs } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Save (or refresh) this device's push subscription. Body: {subscription, prefs?}. */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "push-subscribe"), 20, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<{ subscription?: unknown; prefs?: unknown }>(req);
  const sub = parseSubscription(body.subscription);
  if (!sub) return fail("Invalid push subscription.");
  if (body.prefs !== undefined && normalizePrefs(body.prefs) === null) return fail("Invalid prefs.");
  if (!pushConfigured()) return fail("Notifications are not configured on the server.", 503);

  const existing = (
    await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).limit(1)
  )[0];
  // A re-subscribe without prefs keeps what the user chose before.
  const base = existing ? (normalizePrefs(existing.prefs) ?? undefined) : undefined;
  const prefs = normalizePrefs(body.prefs, base) as PushPrefs;
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
  const now = new Date();

  const saved = await db
    .insert(pushSubscriptions)
    .values({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, userAgent, prefs, createdAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: sub.p256dh, auth: sub.auth, userAgent, prefs, lastSeenAt: now },
    })
    .returning({ endpoint: pushSubscriptions.endpoint, prefs: pushSubscriptions.prefs });
  return ok({ ok: true, endpoint: saved[0].endpoint, prefs: saved[0].prefs }, existing ? 200 : 201);
}
