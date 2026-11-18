import { SeedButton, SelfTestPanel, SettingsForm, TestWebhookButton } from "@/components/SettingsClient";
import { Badge, Card, SectionTitle, StatTile } from "@/components/ui";
import { getAuditTrail, getStaleMessageCount, getVendorsList } from "@/lib/queries";
import { getSettings } from "@/lib/settings";
import { buildTestWebhookPayload } from "@/lib/testpayload";
import { timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";

const SECURITY_ITEMS = [
  ["Secrets in server env only", "WhatsApp token / app secret / LLM keys are read from process.env on the server. Presence flags are shown to the UI — never the values."],
  ["Signed webhook deliveries", "X-Hub-Signature-256 HMAC-SHA256 verified with a timing-safe compare; unsigned or tampered payloads are rejected and logged."],
  ["No secret logging", "Raw webhook bodies and tokens are never written to logs. Audit events store entity ids and summaries only."],
  ["Immutable audit trail", "Every ledger mutation writes an append-only audit_event row (actor, action, summary) for dispute resolution."],
  ["Retry queue, no data loss", "Unparseable or failed deliveries land in sync_queue and are retried up to 5 times instead of being dropped."],
  ["Exact money maths", "All amounts are stored as integer minor units (paisa) so balances never drift like floating point sums."],
  ["Offline-first shell", "Service worker caches the app shell so the ledger is readable with poor connectivity; API data is always fetched fresh."],
  ["Least-privilege vendor data", "Each vendor has an isolated khata; deleting a vendor cascades its entries and messages."],
];

export default async function SettingsPage() {
  const [settings, vendorList, audit] = await Promise.all([
    getSettings(),
    getVendorsList(),
    getAuditTrail(10),
  ]);
  const vendorCount = vendorList.vendors.length;
  const stale = await getStaleMessageCount();

  const testPayload = buildTestWebhookPayload(audit.length + 1);

  return (
    <div className="space-y-5 rise">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Vendors" value={String(vendorCount)} />
        <StatTile label="Audit events" value={String(vendorList.vendors.reduce((a, v) => a + v.count, 0))} sub="ledger entries" />
        <StatTile label="Stored msgs" value={String(stale)} sub="last 7d+" />
      </div>

      <a href="/guide" className="btn btn-primary block w-full text-center">
        📖 Open the step-by-step Guide
      </a>

      <SettingsForm initial={settings} />

      <Card className="border-indigo-400/30 bg-indigo-500/10">
        <SectionTitle title="WhatsApp integration" hint="Meta WhatsApp Business Cloud API" />
        <div className="space-y-2">
          <div>
            <p className="label">Callback URL</p>
            <p className="mono break-all rounded-lg border border-white/10 bg-black/30 p-2">
              /api/webhook/whatsapp
            </p>
          </div>
          <div>
            <p className="label">Verify token</p>
            <p className="mono break-all rounded-lg border border-white/10 bg-black/30 p-2">
              {settings.webhookVerifyToken}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={process.env.WHATSAPP_TOKEN ? "credit" : "warn"}>
              token {process.env.WHATSAPP_TOKEN ? "present" : "missing"}
            </Badge>
            <Badge tone={process.env.WHATSAPP_APP_SECRET ? "credit" : "warn"}>
              app secret {process.env.WHATSAPP_APP_SECRET ? "present" : "missing"}
            </Badge>
            <Badge tone={process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ? "credit" : "muted"}>
              photo bills {process.env.GEMINI_API_KEY ? "gemini (free)" : process.env.OPENAI_API_KEY ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "off"}
            </Badge>
            <Badge tone={process.env.ANTHROPIC_API_KEY ? "credit" : "muted"}>
              llm {process.env.ANTHROPIC_API_KEY ? "anthropic" : "rules only"}
            </Badge>
          </div>
          <TestWebhookButton payload={testPayload} />
        </div>
      </Card>

      <SelfTestPanel />

      <Card className="border-white/5">
        <SectionTitle title="Security & compliance audit" hint="Implemented safeguards" />
        <div className="space-y-2">
          {SECURITY_ITEMS.map(([title, body]) => (
            <div key={title} className="rounded-xl border border-white/10 bg-white/5 p-2">
              <p className="text-[13px] font-semibold">✅ {title}</p>
              <p className="tiny muted mt-0.5">{body}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="border-white/5">
        <SectionTitle title="iOS behaviour" hint="Installed as a home-screen app" />
        <ul className="tiny muted space-y-1">
          <li>Runs standalone (no browser chrome) with dark status bar and safe-area insets.</li>
          <li>Bottom tab bar respects the home-indicator safe area.</li>
          <li>Service worker keeps the shell available offline; ledger data stays live.</li>
          <li>Share-sheet friendly: CSV export and wa.me deep links open WhatsApp directly.</li>
          <li>Background sync is triggered by the webhook server — nothing is lost when the app is closed.</li>
        </ul>
      </Card>

      <SeedButton hasData={vendorCount > 0} />

      <Card className="border-white/5">
        <SectionTitle title="Recent audit events" hint="Append-only trail" />
        {audit.length === 0 ? (
          <p className="tiny muted">No events yet.</p>
        ) : (
          <div className="space-y-2">
            {audit.map((event, index) => (
              <div key={`${event.action}-${index}`} className="flex items-start justify-between gap-2">
                <div>
                  <p className="tiny font-semibold">{event.action}</p>
                  <p className="tiny muted">{event.summary ?? "—"}</p>
                </div>
                <p className="tiny muted whitespace-nowrap">
                  {event.actor} · {timeAgo(event.created_at)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
