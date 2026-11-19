import { strFromU8, unzipSync } from "fflate";
import { fail, ok, parseId, rateLimit, clientKey } from "@/lib/api";
import { postChatImport, vendorNameFromFileName } from "@/lib/chatimport-post";
import { captureAuthorized } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 4_000_000; // hosting request-body limit

/**
 * One-step import of a WhatsApp "Export Chat" file (.zip or .txt) straight from
 * the iPhone Share menu, no file browsing. The vendor is taken from the file
 * name ("WhatsApp Chat - Ahmed Traders.zip"); an unknown name creates the vendor.
 * multipart/form-data: file (required), vendorId (optional), name (optional).
 */
export async function POST(req: Request) {
  if (!(await captureAuthorized(req))) return fail("unauthorized", 401);
  if (!rateLimit(clientKey(req, "import-file"), 20, 60_000)) return fail("rate-limited", 429);

  let file: File | null = null;
  let vendorIdRaw: string | null = null;
  let nameField: string | null = null;
  try {
    const form = await req.formData();
    for (const key of ["file", "chat", "image"]) {
      const v = form.get(key);
      if (v && typeof v !== "string") {
        file = v;
        break;
      }
    }
    vendorIdRaw = form.get("vendorId") ? String(form.get("vendorId")) : null;
    nameField = form.get("name") ? String(form.get("name")).trim() : null;
  } catch {
    return fail("Could not read the file.");
  }
  if (!file) return fail("Attach the exported chat file.");
  if (file.size > MAX_BYTES) return fail("This chat export is too large (max 4 MB). Export 'Without Media'.", 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  let text: string;
  try {
    if (isZip) {
      const files = unzipSync(bytes);
      const name = Object.keys(files).find((n) => /\.txt$/i.test(n));
      if (!name) return fail("No chat text found inside the zip.");
      text = strFromU8(files[name]);
    } else {
      text = new TextDecoder("utf-8").decode(bytes);
    }
  } catch {
    return fail("Could not open this file. Export the chat 'Without Media' and try again.");
  }

  const vendorName = nameField || vendorNameFromFileName(file.name);
  const out = await postChatImport({ text, vendorId: parseId(vendorIdRaw), vendorName });
  if ("error" in out) return fail(out.error, 422);

  const parts: string[] = [];
  if (out.imported) {
    parts.push(`Added ${out.imported} ${out.imported === 1 ? "entry" : "entries"} to ${out.vendorName}`);
    if (out.createdVendor) parts.push("(new vendor)");
    if (out.drafts) parts.push(`${out.drafts} to check in Inbox.`);
  } else if (out.duplicates) {
    parts.push("Nothing new: this chat was already imported.");
  } else {
    parts.push("No bills or payments found in this chat.");
  }
  if (out.imported && out.duplicates) parts.push(`${out.duplicates} were already added.`);
  return ok({ summary: parts.join(" "), ...out }, out.imported ? 201 : 200);
}
