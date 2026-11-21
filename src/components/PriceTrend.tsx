import { formatMinor } from "@/lib/money";

export type TrendSeries = {
  label: string;
  points: Array<{ t: number; v: number }>; // t = epoch ms, v = minor units
};

const COLORS = ["#818cf8", "#34d399", "#fbbf24", "#f472b6", "#38bdf8", "#fb923c"];

/** Dependency-free SVG line chart. Scales to container width (viewBox), no overflow. */
export default function PriceTrend({
  series,
  currency,
  title,
}: {
  series: TrendSeries[];
  currency: string;
  title: string;
}) {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;

  const W = 320;
  const H = 150;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 18;

  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const vMin = Math.min(...all.map((p) => p.v));
  const vMax = Math.max(...all.map((p) => p.v));
  const vSpan = vMax - vMin || Math.max(1, vMax * 0.1);
  const lo = vMin - vSpan * 0.1;
  const hi = vMax + vSpan * 0.1;

  const x = (t: number) =>
    tMax === tMin ? (W - padL - padR) / 2 + padL : padL + ((t - tMin) / (tMax - tMin)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const first = all.reduce((a, b) => (b.t < a.t ? b : a));
  const last = all.reduce((a, b) => (b.t >= a.t ? b : a));
  const desc = `Unit price from ${formatMinor(first.v, currency)} to ${formatMinor(last.v, currency)}; low ${formatMinor(vMin, currency)}, high ${formatMinor(vMax, currency)}; ${all.length} purchases${series.length > 1 ? ` from ${series.length} vendors` : ""}.`;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby="pt-title pt-desc"
        className="block h-auto w-full"
        style={{ maxWidth: "100%" }}
      >
        <title id="pt-title">{title}</title>
        <desc id="pt-desc">{desc}</desc>
        <line x1={padL} x2={W - padR} y1={y(vMax)} y2={y(vMax)} stroke="currentColor" strokeOpacity="0.15" strokeDasharray="3 3" />
        <line x1={padL} x2={W - padR} y1={y(vMin)} y2={y(vMin)} stroke="currentColor" strokeOpacity="0.15" strokeDasharray="3 3" />
        <text x={padL} y={y(vMax) - 4} fontSize="9" fill="currentColor" fillOpacity="0.6">
          {formatMinor(vMax, currency, { decimals: false })}
        </text>
        <text x={padL} y={y(vMin) + 11} fontSize="9" fill="currentColor" fillOpacity="0.6">
          {formatMinor(vMin, currency, { decimals: false })}
        </text>
        {series.map((s, i) => {
          const color = COLORS[i % COLORS.length];
          const pts = [...s.points].sort((a, b) => a.t - b.t);
          const d = pts.map((p, j) => `${j === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
          return (
            <g key={s.label + i}>
              {pts.length > 1 ? <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null}
              {pts.map((p, j) => (
                <circle key={j} cx={x(p.t)} cy={y(p.v)} r="3" fill={color} />
              ))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 ? (
        <figcaption className="tiny muted mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {series.map((s, i) => (
            <span key={s.label + i} className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}
