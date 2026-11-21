import { NextResponse, type NextRequest } from "next/server";
import { sessionToken } from "@/lib/session";

/**
 * Optional password gate. Set APP_PASSWORD on the server to require login;
 * when unset (local dev) the app is open. The WhatsApp webhook is always public
 * (Meta must reach it) — it is protected by its HMAC signature instead.
 */
const PUBLIC = [
  /^\/api\/webhook\/whatsapp/,
  /^\/api\/health$/,
  /^\/login/,
  /^\/api\/login/,
  /^\/api\/capture/, // does its own auth: login cookie OR bearer token (iPhone Shortcut)
  /^\/api\/cron\/daily$/, // does its own auth: Bearer CRON_SECRET (Vercel Cron); 401 otherwise
  /^\/_next\//,
  /^\/(manifest\.webmanifest|sw\.js|icon\.png|apple-touch-icon\.png|favicon\.ico)$/,
];

export async function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  const cookie = req.cookies.get("ll_session")?.value;
  if (cookie && cookie === (await sessionToken(password))) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
