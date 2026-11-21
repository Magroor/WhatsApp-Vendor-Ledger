import { ok } from "@/lib/api";
import { vapidConfig } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Public VAPID key for pushManager.subscribe (the private key never leaves the server). */
export async function GET() {
  const vapid = vapidConfig();
  return ok({ configured: Boolean(vapid), publicKey: vapid?.publicKey ?? null });
}
