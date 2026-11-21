import { clientKey, fail, ok, rateLimit } from "@/lib/api";
import { confirmCleanDrafts } from "@/lib/review";

export const dynamic = "force-dynamic";

/** Confirm all "clean" draft entries at once (known vendor, stated direction, amounts add up). */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "review-confirm"), 10, 60_000)) return fail("Too many attempts. Wait a minute.", 429);
  return ok({ confirmed: await confirmCleanDrafts() });
}
