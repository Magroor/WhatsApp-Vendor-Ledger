/** Shown instantly while a page's data loads, so taps always feel responsive. */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      {[96, 72, 140, 72].map((h, i) => (
        <div
          key={i}
          className="card animate-pulse"
          style={{ height: h, opacity: 0.6 }}
        />
      ))}
    </div>
  );
}
