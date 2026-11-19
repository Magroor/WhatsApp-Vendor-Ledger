import { fail, ok } from "@/lib/api";
import { GEMINI_MODELS } from "@/lib/ingest";
import { captureAuthorized } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Photo-reading checker (behind the app login). Open /api/vision-check after
 * signing in: it says whether the key reached the server and what Google
 * answers for each model. The key itself is never returned.
 */
export async function GET(req: Request) {
  if (!(await captureAuthorized(req))) return fail("unauthorized", 401);
  const key = process.env.GEMINI_API_KEY ?? "";
  const info = {
    keyPresent: key.length > 0,
    keyLength: key.length,
    hasWhitespaceOrQuotes: /^["'\s]|["'\s]$/.test(key),
    looksLikeNameIncluded: key.includes("=") || key.toUpperCase().startsWith("GEMINI"),
    openaiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
  };
  if (!key) {
    return ok({
      ...info,
      verdict:
        "GEMINI_API_KEY is NOT set on this server. In Vercel: Settings → Environment Variables → add GEMINI_API_KEY for Production, then redeploy the newest deployment.",
      models: [],
    });
  }

  if (info.looksLikeNameIncluded) {
    return ok({
      ...info,
      verdict:
        "The value in GEMINI_API_KEY contains the text GEMINI_API_KEY= (or an = sign). Put only the key itself in the Value box, with the name in the Name box. Then redeploy.",
      models: [],
    });
  }

  const models: Array<{ model: string; status: number | string; message: string }> = [];
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key.trim() },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with the single word ok" }] }] }),
        cache: "no-store",
      });
      let message = "ok";
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        message = (j.error?.message ?? "error").slice(0, 160);
      }
      models.push({ model, status: res.status, message });
      if (res.ok) break; // one working model is enough
    } catch (e) {
      models.push({ model, status: "network", message: (e as Error).message.slice(0, 160) });
    }
  }
  const working = models.find((m) => m.status === 200);
  const first = models[0];
  const verdict = working
    ? `Photo reading works (model ${working.model}).`
    : first?.status === 400 || first?.status === 401 || first?.status === 403
      ? "Google rejected the key. Create a new key at aistudio.google.com/apikey, paste it with no spaces or quotes, and redeploy."
      : first?.status === 429
        ? "The free quota is used up for now. Wait a while (or tomorrow) and try again."
        : "Google is busy or unreachable right now. Try again in a minute.";
  return ok({ ...info, verdict, models });
}
