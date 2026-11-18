import Link from "next/link";
import CaptureForm from "@/components/CaptureForm";
import ScanBill from "@/components/ScanBill";
import MessageActions from "@/components/MessageActions";
import { SyncRetryButton } from "@/components/SyncRetryButton";
import { Badge, Card, Money, SectionTitle, StatTile } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import { getInbox } from "@/lib/queries";
import { fmtDateTime, timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Needs review" },
  { key: "parsed", label: "Auto-posted" },
  { key: "ignored", label: "Ignored" },
];

const STATUS_TONE: Record<string, "muted" | "credit" | "debit" | "warn" | "brand"> = {
  parsed: "credit",
  review: "warn",
  pending: "brand",
  processing: "brand",
  ignored: "muted",
  failed: "debit",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; compose?: string }>;
}) {
  const params = await searchParams;
  const status = params.status ?? "all";
  const data = await getInbox(status);
  const pending = data.counts
    .filter((c) => ["pending", "processing", "review"].includes(c.status))
    .reduce((a, c) => a + c.count, 0);
  const total = data.counts.reduce((a, c) => a + c.count, 0);
  const queued = data.queueCounts
    .filter((q) => q.status === "pending")
    .reduce((a, q) => a + q.count, 0);

  return (
    <div className="space-y-5 rise">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Messages" value={String(total)} sub="all time" />
        <StatTile label="To review" value={String(pending)} tone={pending ? "debit" : "credit"} sub="low confidence" />
        <StatTile label="Retry queue" value={String(queued)} tone={queued ? "debit" : "credit"} sub="offline sends" />
      </div>

      <Card className="border-white/10">
        <div className="flex items-start gap-3">
          <span className="text-xl">📲</span>
          <div>
            <p className="h2">How ingestion works on iPhone</p>
            <p className="tiny muted mt-1">
              Vendors send bills to your WhatsApp Business number → Meta delivers the
              webhook → <span className="mono">/api/webhook/whatsapp</span> stores it and the
              parser posts the entry. You can also paste/forward any message below, or
              send bills to the number and let background sync collect them.
            </p>
          </div>
        </div>
      </Card>

      <SyncRetryButton pending={queued} />

      <ScanBill vendors={data.vendors.map((v) => ({ id: v.id, name: v.name }))} />

      <CaptureForm vendors={data.vendors} autoOpen={params.compose === "1"} />

      <div>
        <SectionTitle title="Inbox" hint="Raw messages with parse outcome" />
        <div className="chip-scroll">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/inbox?status=${f.key}`} className="chip" data-active={status === f.key}>
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {data.messages.length === 0 ? (
          <Card>
            <p className="tiny muted">No messages for this filter.</p>
          </Card>
        ) : (
          data.messages.map((m) => (
            <Card key={m.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[15px] font-semibold">
                      {m.vendorName ?? m.profileName ?? m.fromPhone ?? "Unknown sender"}
                    </p>
                    <Badge tone={STATUS_TONE[m.parseStatus] ?? "muted"}>{m.parseStatus}</Badge>
                  </div>
                  <p className="tiny muted mt-1">
                    {m.direction === "out" ? "↗︎ auto-reply" : "↙︎ inbound"} ·{" "}
                    {m.messageType}
                    {m.extractionSource ? ` · ${m.extractionSource}` : ""} ·{" "}
                    {timeAgo(m.receivedAt)}
                  </p>
                </div>
                <div className="text-right">
                  {m.txAmountMinor !== null ? (
                    <>
                      <Money
                        minor={m.txEntryType === "credit" ? m.txAmountMinor : -m.txAmountMinor}
                        currency={m.txCurrency ?? "PKR"}
                        className="text-[15px] font-bold"
                        decimals={false}
                      />
                      <p className="tiny muted">entry #{m.transactionId}</p>
                    </>
                  ) : (
                    <p className="tiny muted">no entry</p>
                  )}
                </div>
              </div>

              {m.mediaId && ["image", "document", "audio"].includes(m.messageType) ? (
                <div className="mt-2 rounded-xl border border-dashed border-white/20 bg-white/5 p-3">
                  {m.messageType === "image" ? (
                    <a href={`/api/media/${m.id}`} target="_blank" rel="noopener noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/media/${m.id}`}
                        alt="Bill image sent on WhatsApp"
                        loading="lazy"
                        className="mx-auto max-h-56 w-auto rounded-lg object-contain"
                      />
                    </a>
                  ) : null}
                  <p className="tiny muted mt-1 text-center">
                    <a href={`/api/media/${m.id}`} target="_blank" rel="noopener noreferrer" className="underline">
                      {m.messageType === "image" ? "Open original bill" : m.messageType === "audio" ? "Play voice note" : "Open document"}
                    </a>
                    {" · "}
                    {m.ocrText
                      ? "text extracted below"
                      : m.parseStatus === "pending" || m.parseStatus === "processing"
                        ? "extraction in progress"
                        : "no text extracted"}
                  </p>
                </div>
              ) : null}

              {m.body || m.caption ? (
                <p className="bubble mt-2">{(m.body ?? m.caption)?.slice(0, 600)}</p>
              ) : null}
              {m.ocrText && m.ocrText.trim() !== (m.body ?? m.caption ?? "").trim() ? (
                <p className="bubble mt-2">
                  <span className="tiny muted block">Extracted text</span>
                  {m.ocrText.slice(0, 600)}
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={m.parseConfidence >= 75 ? "credit" : "warn"}>
                  {m.parseConfidence}% confidence
                </Badge>
                {m.txStatus === "draft" ? <Badge tone="warn">draft entry</Badge> : null}
                {m.vendorId ? (
                  <Link href={`/vendors/${m.vendorId}`} className="pill">
                    Open khata →
                  </Link>
                ) : null}
              </div>

              {m.direction === "in" ? (
                <MessageActions messageId={m.id} parseStatus={m.parseStatus} hasTransaction={m.transactionId !== null} />
              ) : null}

              <p className="tiny muted mt-2">{fmtDateTime(m.receivedAt)}</p>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
