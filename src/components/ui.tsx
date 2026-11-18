import type { ReactNode } from "react";
import { formatMinor } from "@/lib/money";

export function Card({
  children,
  className = "",
  press = false,
}: {
  children: ReactNode;
  className?: string;
  press?: boolean;
}) {
  return (
    <div className={`card ${press ? "card-press" : ""} ${className}`}>{children}</div>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div>
        <h2 className="h2">{title}</h2>
        {hint ? <p className="tiny muted mt-0.5">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "credit" | "debit" | "brand";
}) {
  const color =
    tone === "credit"
      ? "money-pos"
      : tone === "debit"
        ? "money-neg"
        : tone === "brand"
          ? "text-indigo-300"
          : "money-neutral";
  return (
    <div className="tile">
      <p className="tiny muted font-semibold uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-[17px] font-bold tabular-nums ${color}`}>{value}</p>
      {sub ? <p className="tiny muted mt-0.5">{sub}</p> : null}
    </div>
  );
}

export function Money({
  minor,
  currency = "PKR",
  className = "",
  decimals,
}: {
  minor: number;
  currency?: string;
  className?: string;
  decimals?: boolean;
}) {
  const tone =
    minor > 0 ? "money-pos" : minor < 0 ? "money-neg" : "money-neutral";
  return (
    <span className={`tabular-nums ${tone} ${className}`}>
      {formatMinor(minor, currency, { decimals })}
    </span>
  );
}

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "credit" | "debit" | "warn" | "brand";
  children: ReactNode;
}) {
  const cls =
    tone === "credit"
      ? "pill-credit"
      : tone === "debit"
        ? "pill-debit"
        : tone === "warn"
          ? "pill-warn"
          : tone === "brand"
            ? "pill-brand"
            : "";
  return <span className={`pill ${cls}`}>{children}</span>;
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  return <div className="avatar">{initials || "?"}</div>;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 py-8 text-center">
      <span className="text-3xl">{icon}</span>
      <p className="h2">{title}</p>
      {hint ? <p className="tiny muted max-w-[260px]">{hint}</p> : null}
      {action}
    </div>
  );
}

export function Progress({ value, tone = "brand" }: { value: number; tone?: "brand" | "credit" | "debit" }) {
  const bg =
    tone === "credit"
      ? "linear-gradient(90deg,#6ee7b7,#10b981)"
      : tone === "debit"
        ? "linear-gradient(90deg,#fda4af,#f43f5e)"
        : "linear-gradient(90deg,#818cf8,#c084fc)";
  return (
    <div className="progress">
      <span style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: bg }} />
    </div>
  );
}

export function Bars({
  points,
  currency,
}: {
  points: Array<{ label: string; creditMinor: number; debitMinor: number }>;
  currency: string;
}) {
  const max = Math.max(
    1,
    ...points.map((p) => Math.max(p.creditMinor, p.debitMinor)),
  );
  const step = Math.max(1, Math.ceil(points.length / 14));
  return (
    <div>
      <div className="bars">
        {points.map((p, i) => (
          <div key={`${p.label}-${i}`} className="bar-group">
            <div
              className="bar bar-credit"
              style={{ height: `${(p.creditMinor / max) * 100}%` }}
              title={`Credit ${formatMinor(p.creditMinor, currency)}`}
            />
            <div
              className="bar bar-debit"
              style={{ height: `${(p.debitMinor / max) * 100}%` }}
              title={`Debit ${formatMinor(p.debitMinor, currency)}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between tiny muted">
        {points
          .filter((_, i) => i % step === 0)
          .map((p, i) => (
            <span key={`${p.label}-lbl-${i}`}>{p.label}</span>
          ))}
      </div>
    </div>
  );
}
