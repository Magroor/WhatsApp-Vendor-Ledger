import { fail, ok, clientKey, rateLimit } from "@/lib/api";
import { captureAuthorized } from "@/lib/session";
import { interpretVoice } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 3_500_000; // ~100 s of 16 kHz mono WAV; the app records at most 30 s
const OK_MIME = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/aac", "audio/ogg", "audio/flac", "audio/aiff"]);

/**
 * Hear a voice command and return what it means. Nothing is saved: the app shows the result
 * (what was heard, amount, vendor, Bill or Paid) and the person confirms it.
 * multipart/form-data: audio (file).
 */
export async function POST(req: Request) {
  if (!(await captureAuthorized(req))) return fail("unauthorized", 401);
  if (!rateLimit(clientKey(req, "voice"), 20, 60_000)) return fail("Too many recordings. Wait a minute.", 429);

  let file: File | null = null;
  try {
    const form = await req.formData();
    const v = form.get("audio");
    if (v && typeof v !== "string") file = v;
  } catch {
    return fail("Could not read the recording.");
  }
  if (!file) return fail("No recording attached.");
  if (file.size < 2_000) return fail("The recording was empty. Hold the button and speak, then try again.");
  if (file.size > MAX_BYTES) return fail("That recording is too long. Keep it under 30 seconds.", 413);
  const mime = (file.type || "audio/wav").split(";")[0].toLowerCase();
  if (!OK_MIME.has(mime)) return fail("Unsupported audio format.");

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await interpretVoice(bytes.toString("base64"), mime === "audio/x-wav" || mime === "audio/wave" ? "audio/wav" : mime);
  if (!result.command) return fail(result.error ?? "Could not understand the recording.", 502);
  return ok(result.command);
}
