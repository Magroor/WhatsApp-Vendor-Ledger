import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { clientKey, fail, ok, readJson, rateLimit } from "@/lib/api";
import { isValidPushEndpoint, normalizePrefs } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Read this device's prefs (used by the settings card to show the toggles). Query: ?endpoint= */
export async function GET(req: Request) {
  if (!rateLimit(clientKey(req, "push-prefs-get"), 60, 60_000)) return fail("rate-limited", 429);
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  if (!isValidPushEndpoint(endpoint)) return fail("Invalid endpoint.");
  const row = (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).limit(1))[0];
  if (!row) return fail("Subscription not found.", 404);
  return ok({ endpoint, prefs: normalizePrefs(row.prefs) });
}

/** Change which notifications this device gets. Body: {endpoint, prefs}. */
export async function PATCH(req: Request) {
  if (!rateLimit(clientKey(req, "push-prefs"), 30, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<{ endpoint?: unknown; prefs?: unknown }>(req);
  if (!isValidPushEndpoint(body.endpoint)) return fail("Invalid endpoint.");
  if (!body.prefs || typeof body.prefs !== "object") return fail("Invalid prefs.");
  const row = (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint)).limit(1))[0];
  if (!row) return fail("Subscription not found.", 404);
  const prefs = normalizePrefs(body.prefs, normalizePrefs(row.prefs) ?? undefined);
  if (!prefs) return fail("Invalid prefs.");
  await db.update(pushSubscriptions).set({ prefs, lastSeenAt: new Date() }).where(eq(pushSubscriptions.id, row.id));
  return ok({ ok: true, prefs });
}
