export async function sessionToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("khatalink-session-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Auth for endpoints that must also work without a browser cookie (the iPhone
 * Share Sheet Shortcut): accepts the login cookie OR `Authorization: Bearer
 * <CAPTURE_TOKEN>`. Locally (no APP_PASSWORD, not production) it is open.
 */
export async function captureAuthorized(req: Request): Promise<boolean> {
  const password = process.env.APP_PASSWORD;
  const token = process.env.CAPTURE_TOKEN;
  if (!password && !token) return process.env.NODE_ENV !== "production";

  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token && bearer && safeEqual(bearer, token)) return true;

  if (password) {
    const cookie = (req.headers.get("cookie") ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("ll_session="))
      ?.slice("ll_session=".length);
    if (cookie && safeEqual(cookie, await sessionToken(password))) return true;
  }
  return false;
}
