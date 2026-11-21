import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import ConfirmClean from "@/components/ConfirmClean";
import QuickResolve from "@/components/QuickResolve";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatMinor } from "@/lib/money";
import { getReviewItems } from "@/lib/review";
import { timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const [items, vendorRows] = await Promise.all([
    getReviewItems(40),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.archived, false)).orderBy(asc(vendors.name)),
  ]);
  const clean = items.filter((i) => i.clean);
  const decide = items.filter((i) => !i.clean);

  if (items.length === 0) {
    return (
      <div className="space-y-4 rise">
        <EmptyState icon="🎉" title="All caught up" hint="Nothing is waiting for you. New bills that need a decision will appear here." action={<Link href="/" className="btn btn-primary">Back to Home</Link>} />
      </div>
    );
  }

  return (
    <div className="space-y-4 rise">
      <p className="tiny muted">
        {items.length} waiting · {clean.length} look clean · {decide.length} need a decision
      </p>

      {clean.length ? (
        <ConfirmClean
          items={clean.map((i) => ({
            id: i.messageId,
            label: `${i.entryType === "credit" ? "🧾 Bill" : "💸 Paid"} ${formatMinor(i.amountMinor ?? 0, i.currency)} · ${i.vendorName ?? ""}`,
          }))}
        />
      ) : null}

      {decide.map((i) => (
        <Card key={i.messageId}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="tiny muted">
                {i.messageType} · {timeAgo(i.receivedAt)}
                {i.vendorName && !i.vendorName.startsWith("Unassigned") ? ` · ${i.vendorName}` : ""}
              </p>
              {i.text ? <p className="bubble mt-1 line-clamp-3" dir="auto">{i.text}</p> : null}
            </div>
            <Badge tone={i.confidence >= 65 ? "credit" : "warn"}>{i.confidence}%</Badge>
          </div>

          {i.hasMedia ? (
            <a href={`/api/media/${i.messageId}`} target="_blank" rel="noopener noreferrer" className="mt-2 block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/media/${i.messageId}`} alt="Bill" loading="lazy" className="mx-auto max-h-48 w-auto rounded-lg object-contain" />
            </a>
          ) : null}

          {i.amountMinor ? (
            <QuickResolve
              key={`${i.messageId}-${i.vendorId}-${i.entryType}`}
              messageId={i.messageId}
              vendors={vendorRows}
              vendorId={i.vendorId}
              vendorName={i.vendorName}
              amountMinor={i.amountMinor}
              entryType={i.entryType}
              assumed={i.assumedDirection}
              currency={i.currency}
              kind={i.vendorKind}
            />
          ) : (
            <p className="mt-2 rounded-xl bg-white/5 p-3 text-sm">
              No amount was found here. Open it in the <Link href="/inbox" className="underline">Inbox</Link> to type the amount, or ignore it.
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
