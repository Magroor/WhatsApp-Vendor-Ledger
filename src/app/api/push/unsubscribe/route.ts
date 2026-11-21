import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { clientKey, fail, ok, readJson, rateLimit } from "@/lib/api";
import { isValidPushEndpoint } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Forget this device. Body: {endpoint}. */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "push-unsubscribe"), 20, 60_000)) return fail("rate-limited", 429);
  const body = await readJson<{ endpoint?: unknown }>(req);
  if (!isValidPushEndpoint(body.endpoint)) return fail("Invalid endpoint.");
  const removed = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, body.endpoint))
    .returning({ id: pushSubscriptions.id });
  return ok({ ok: true, removed: removed.length });
}
