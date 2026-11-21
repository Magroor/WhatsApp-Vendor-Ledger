"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Alias = { id: number; kind: string; alias: string };

/** Names and phone numbers the app learned for this vendor from bills. Remove any that are wrong. */
export default function VendorAliases({ vendorId, aliases }: { vendorId: number; aliases: Alias[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (aliases.length === 0) return null;

  async function remove(id: number) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/aliases?aliasId=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove it");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card space-y-2">
      <div>
        <p className="h2">Also known as</p>
        <p className="tiny muted">Bills with these names or numbers go to this vendor automatically. Remove any that are wrong.</p>
      </div>
      <ul className="flex flex-wrap gap-2">
        {aliases.map((a) => (
          <li key={a.id} className="flex items-center gap-1 rounded-full border border-white/15 bg-white/5 py-1 pl-3 pr-1 text-sm">
            <span dir="auto">
              {a.kind === "phone" ? "📞 " : ""}
              {a.alias}
            </span>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-full text-lg"
              aria-label={`Remove ${a.alias}`}
              onClick={() => remove(a.id)}
              disabled={busy === a.id}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}
