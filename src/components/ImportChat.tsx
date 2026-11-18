"use client";

import { unzipSync, strFromU8 } from "fflate";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Vendor = { id: number; name: string };
type Entry = {
  hash: string;
  at: string;
  sender: string;
  text: string;
  entryType: "credit" | "debit";
  amountMinor: number;
  confidence: number;
};

async function readChatFile(file: File): Promise<string> {
  const isZip = /\.zip$/i.test(file.name) || file.type === "application/zip";
  if (!isZip) return file.text();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const name = Object.keys(files).find((n) => /\.txt$/i.test(n));
  if (!name) throw new Error("No chat text file found inside the zip.");
  return strFromU8(files[name]);
}

const money = (minor: number) =>
  `Rs ${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export default function ImportChat({ vendors }: { vendors: Vendor[] }) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState<string>(vendors[0] ? String(vendors[0].id) : "new");
  const [newName, setNewName] = useState("");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ imported: number; duplicates: number; vendorId: number } | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setEntries(null);
    try {
      setText(await readChatFile(file));
      setFileName(file.name);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function call(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          commit,
          vendorId: vendorId === "new" ? undefined : Number(vendorId),
          newVendorName: vendorId === "new" ? newName : undefined,
          skip: [...skip],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Something went wrong");
      if (commit) {
        setDone(json);
        router.refresh();
      } else {
        setEntries(json.entries);
        setTotal(json.totalMessages);
        setSkip(new Set());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card space-y-3 text-center">
        <p className="text-3xl">✅</p>
        <p className="h2">{done.imported} entries added</p>
        {done.duplicates > 0 ? (
          <p className="tiny muted">{done.duplicates} were already imported and were skipped.</p>
        ) : null}
        <a className="btn btn-primary w-full" href={`/vendors/${done.vendorId}`}>
          Open vendor ledger
        </a>
      </div>
    );
  }

  const included = entries ? entries.filter((e) => !skip.has(e.hash)).length : 0;

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <p className="h2">1 · Which vendor is this chat with?</p>
        <select className="field" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          <option value="new">➕ New vendor…</option>
        </select>
        {vendorId === "new" ? (
          <input
            className="field"
            placeholder="Vendor name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        ) : null}
      </div>

      <div className="card space-y-3">
        <p className="h2">2 · Add the exported chat</p>
        <label className="btn w-full cursor-pointer text-center">
          📎 {fileName || "Choose exported file (.txt or .zip)"}
          <input
            type="file"
            accept=".txt,.zip,text/plain,application/zip"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </label>
        <p className="tiny muted text-center">or paste the chat text</p>
        <textarea
          className="field"
          rows={4}
          placeholder="[12/02/2026, 10:15] Ahmed: 5 bags cement total 7500 udhaar"
          value={fileName ? "" : text}
          onChange={(e) => {
            setText(e.target.value);
            setEntries(null);
          }}
        />
        <button
          className="btn btn-primary w-full"
          disabled={busy || !text.trim() || (vendorId === "new" && !newName.trim())}
          onClick={() => call(false)}
        >
          {busy && !entries ? "Reading chat…" : "Find bills & payments"}
        </button>
      </div>

      {error ? <p className="rounded-xl bg-rose-500/15 p-3 text-sm text-rose-200">{error}</p> : null}

      {entries ? (
        <div className="card space-y-3">
          <p className="h2">3 · Check what was found</p>
          <p className="tiny muted">
            Found {entries.length} entries in {total} messages. Untick anything that is wrong.
          </p>
          {entries.length === 0 ? (
            <p className="text-sm">No amounts were found in this chat.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.hash} className="rounded-xl border border-white/10 bg-white/5 p-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5"
                      checked={!skip.has(e.hash)}
                      onChange={() => {
                        const next = new Set(skip);
                        if (next.has(e.hash)) next.delete(e.hash);
                        else next.add(e.hash);
                        setSkip(next);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex justify-between gap-2">
                        <span className={e.entryType === "credit" ? "money-pos font-semibold" : "money-neg font-semibold"}>
                          {e.entryType === "credit" ? "Bill (credit)" : "Payment (debit)"} · {money(e.amountMinor)}
                        </span>
                        <span className="tiny muted">{new Date(e.at).toLocaleDateString()}</span>
                      </span>
                      <span className="tiny muted line-clamp-2 block">{e.text}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {entries.length > 0 ? (
            <button className="btn btn-primary w-full" disabled={busy || included === 0} onClick={() => call(true)}>
              {busy ? "Importing…" : `Import ${included} entries`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
