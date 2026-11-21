import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { clientKey, fail, ok, readJson, rateLimit } from "@/lib/api";
import { isValidPushEndpoint, pushConfigured, sendPush } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Sends a test notification to the caller's own (already saved) subscription. Body: {endpoint}. */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "push-test"), 5, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<{ endpoint?: unknown }>(req);
  if (!isValidPushEndpoint(body.endpoint)) return fail("Invalid endpoint.");
  if (!pushConfigured()) return fail("Notifications are not configured on the server.", 503);
  const sub = (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint)).limit(1))[0];
  if (!sub) return fail("This device is not subscribed. Turn notifications on first.", 404);
  const result = await sendPush(sub, {
    title: "KhataLink test",
    body: "Notifications are working. (Notification theek aa raha hai)",
    url: "/settings",
    tag: "test",
  });
  if (result.gone) return fail("This device's subscription expired. Turn notifications off and on again.", 410);
  if (!result.ok) return fail("The push service did not accept the test notification.", 502, { statusCode: result.statusCode });
  await db.update(pushSubscriptions).set({ lastSeenAt: new Date() }).where(eq(pushSubscriptions.id, sub.id));
  return ok({ ok: true });
}
