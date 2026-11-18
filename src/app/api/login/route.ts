import { NextResponse } from "next/server";
import { clientKey, fail, rateLimit, readJson } from "@/lib/api";
import { sessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.json({ ok: true });
  if (!rateLimit(clientKey(req, "login"), 8, 60_000)) {
    return fail("Too many attempts. Wait a minute and try again.", 429);
  }
  const body = await readJson<{ password?: string }>(req);
  if (body.password !== password) return fail("Wrong password.", 401);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("ll_session", await sessionToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}
