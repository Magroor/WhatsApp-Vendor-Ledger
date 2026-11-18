import crypto from "node:crypto";
import {
  ANTHROPIC_VISION_MODEL,
  buildAnthropicVisionRequest,
  buildOpenAIVisionRequest,
  composeSourceText,
  isOcrMime,
  messageStatusForTx,
  planReparse,
  readAnthropicText,
  readOpenAIText,
  reviveInbound,
} from "./ingest";
import type { TestResult } from "./selftest";
import { matchPhoneCandidates, normalizePhone, verifySignature } from "./wa";

/** Pure / unit checks for the WhatsApp ingestion pipeline (no DB, no network). */
export function runIngestSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const check = (suite: string, name: string, pass: boolean, detail: string) =>
    results.push({ suite, name, pass, detail });

  // ---- webhook signature
  const body = '{"entry":[]}';
  const secret = "test-app-secret";
  const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  check("ingest.signature", "valid signature accepted", verifySignature(body, `sha256=${sig}`, secret, "production").ok, "hmac ok");
  check("ingest.signature", "uppercase hex accepted", verifySignature(body, `sha256=${sig.toUpperCase()}`, secret, "production").ok, "case-insensitive");
  const noSecretProd = verifySignature(body, null, undefined, "production");
  check("ingest.signature", "no secret fails closed in production", !noSecretProd.ok && noSecretProd.reason === "no-secret-configured", String(noSecretProd.reason));
  const noSecretDev = verifySignature(body, null, undefined, "development");
  check("ingest.signature", "no secret allowed in dev with reason", noSecretDev.ok && !!noSecretDev.reason, String(noSecretDev.reason));
  const nonHex = verifySignature(body, `sha256=${"z".repeat(64)}`, secret, "production");
  check("ingest.signature", "non-hex signature rejected", !nonHex.ok && nonHex.reason === "malformed-signature", String(nonHex.reason));
  // Buffer.from drops invalid hex chars; a valid prefix + junk must not pass.
  check("ingest.signature", "valid hex + junk rejected", !verifySignature(body, `sha256=${sig}zz`, secret, "production").ok, "length-checked");
  check("ingest.signature", "short signature rejected", !verifySignature(body, "sha256=deadbeef", secret, "production").ok, "reject");
  check("ingest.signature", "missing header rejected", !verifySignature(body, null, secret, "production").ok, "reject");

  // ---- phone matching
  check("ingest.phone", "normalize keeps full digits", normalizePhone("+92 300-1234567") === "923001234567", String(normalizePhone("+92 300-1234567")));
  check("ingest.phone", "normalize strips 00 prefix", normalizePhone("0092 300 1234567") === "923001234567", String(normalizePhone("0092 300 1234567")));
  const vendorsA = [
    { id: 1, phone: "+92 300 1234567" },
    { id: 2, phone: "+91 300 1234567" },
  ];
  check("ingest.phone", "exact match beats suffix", matchPhoneCandidates(vendorsA, "923001234567")?.id === 1, "id 1");
  check("ingest.phone", "different country codes not merged", matchPhoneCandidates(vendorsA, "+44 300 1234567") === null, "ambiguous suffix -> null");
  check(
    "ingest.phone",
    "local format matches unique international",
    matchPhoneCandidates([{ id: 3, phone: "923001234567" }], "03001234567")?.id === 3,
    "suffix fallback",
  );
  check(
    "ingest.phone",
    "short number never suffix-matched",
    matchPhoneCandidates([{ id: 4, phone: "9212345" }], "12345") === null,
    "no partial match",
  );

  // ---- caption + OCR combined
  const combined = composeSourceText({ body: "paid 5000", caption: "paid 5000", ocrText: "Total 5000" });
  check("ingest.text", "caption kept alongside OCR", combined === "paid 5000\nTotal 5000", JSON.stringify(combined));
  check("ingest.text", "text-only body passes through", composeSourceText({ body: "udhaar 1200" }) === "udhaar 1200", "body");
  check("ingest.text", "empty parts give empty text", composeSourceText({ body: " ", ocrText: null }) === "", "empty");

  // ---- reparse plan
  const incompleteType = planReparse({ draft: { entryType: null, amountMinor: 50000, confidence: 40 }, autoConfirmThreshold: 75 });
  check("ingest.reparse", "no entry type -> not posted", !incompleteType.post, JSON.stringify(incompleteType));
  const incompleteAmt = planReparse({ draft: { entryType: "credit", amountMinor: null, confidence: 40 }, autoConfirmThreshold: 75 });
  check("ingest.reparse", "no amount -> not posted (no 0 entry)", !incompleteAmt.post, JSON.stringify(incompleteAmt));
  const zero = planReparse({ draft: { entryType: "debit", amountMinor: 0, confidence: 90 }, autoConfirmThreshold: 75 });
  check("ingest.reparse", "zero amount -> not posted", !zero.post, JSON.stringify(zero));
  const low = planReparse({ draft: { entryType: "credit", amountMinor: 1000, confidence: 50 }, autoConfirmThreshold: 75 });
  check("ingest.reparse", "low confidence -> draft", low.post && low.status === "draft", JSON.stringify(low));
  check("ingest.reparse", "draft entry keeps message in review", messageStatusForTx("draft") === "review", messageStatusForTx("draft"));
  check("ingest.reparse", "confirmed entry marks message parsed", messageStatusForTx("confirmed") === "parsed", messageStatusForTx("confirmed"));
  const manual = planReparse({
    draft: { entryType: null, amountMinor: null, confidence: 0 },
    override: { entryType: "debit", amountMinor: 250000 },
    autoConfirmThreshold: 75,
  });
  check("ingest.reparse", "reviewer override confirms", manual.post && manual.status === "confirmed" && manual.amountMinor === 250000, JSON.stringify(manual));
  const voided = planReparse({ draft: { entryType: "credit", amountMinor: 1000, confidence: 99 }, autoConfirmThreshold: 75, existingStatus: "void" });
  const sticky = planReparse({ draft: { entryType: "credit", amountMinor: 1000, confidence: 30 }, autoConfirmThreshold: 75, existingStatus: "confirmed" });
  check("ingest.reparse", "plain re-parse keeps confirmed entry confirmed", sticky.post && sticky.status === "confirmed", JSON.stringify(sticky));
  check("ingest.reparse", "void stays void", voided.post && voided.status === "void", JSON.stringify(voided));

  // ---- vision request format
  const anth = buildAnthropicVisionRequest("QUJD", "image/JPEG; foo=bar");
  const anthBlock = anth.messages[0].content[0] as { type: string; source: { type: string; media_type: string } };
  check("ingest.vision", "anthropic model id", anth.model === "claude-haiku-4-5" && ANTHROPIC_VISION_MODEL === "claude-haiku-4-5", anth.model);
  check(
    "ingest.vision",
    "anthropic image block before text",
    anthBlock.type === "image" && anthBlock.source.type === "base64" && anthBlock.source.media_type === "image/jpeg" && anth.messages[0].content[1].type === "text",
    JSON.stringify(anthBlock.source.media_type),
  );
  check("ingest.vision", "anthropic system prompt top-level", typeof anth.system === "string" && anth.max_tokens > 0, "system + max_tokens");
  const anthPdf = buildAnthropicVisionRequest("QUJD", "application/pdf").messages[0].content[0] as { type: string };
  check("ingest.vision", "anthropic pdf uses document block", anthPdf.type === "document", anthPdf.type);
  check(
    "ingest.vision",
    "anthropic text read from text blocks only",
    readAnthropicText({ content: [{ type: "text", text: "Total 500" }, { type: "tool_use", id: "x" }], stop_reason: "end_turn" }).text === "Total 500",
    "text",
  );
  check("ingest.vision", "anthropic refusal yields no text", readAnthropicText({ content: [], stop_reason: "refusal" }).text === null, "refusal");
  const oai = buildOpenAIVisionRequest("QUJD", "image/png");
  check("ingest.vision", "openai uses same system prompt", oai.messages[0].role === "system" && oai.messages[0].content === anth.system, "consistent");
  check("ingest.vision", "openai text parsed", readOpenAIText({ choices: [{ message: { content: " Total 9 " } }] }).text === "Total 9", "text");
  check("ingest.vision", "unsupported mime skipped", !isOcrMime("image/heic") && isOcrMime("image/webp"), "heic not sent");

  // ---- queue payload revival
  const revived = reviveInbound({ waMessageId: "wamid.1", from: "92300", receivedAt: "2026-01-02T03:04:05.000Z" });
  check("ingest.queue", "queued payload date revived", revived?.receivedAt instanceof Date && revived.receivedAt.getUTCFullYear() === 2026, String(revived?.receivedAt));
  check("ingest.queue", "garbage payload rejected", reviveInbound({ raw: "x" }) === null, "null");

  return results;
}
