import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * All monetary values are stored as INTEGER MINOR UNITS (paisa / cents).
 * This removes floating point drift from ledger maths.
 */

export const vendors = pgTable(
  "vendors",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    phone: text("phone"),
    businessType: text("business_type"),
    city: text("city"),
    currency: text("currency").notNull().default("PKR"),
    creditTermsDays: integer("credit_terms_days").notNull().default(30),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" })
      .notNull()
      .default(0),
    autoCreateSource: text("auto_create_source").default("manual"),
    needsReview: boolean("needs_review").notNull().default(false),
    // vendor = a supplier we owe; customer = someone who buys from us on credit (same ledger maths:
    // credit = bill / sale on credit, debit = payment).
    kind: text("kind").notNull().default("vendor"),
    notes: text("notes"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("vendors_phone_idx").on(t.phone)],
);

/** Raw WhatsApp messages (inbound + outbound copies) — immutable audit source. */
export const waMessages = pgTable(
  "wa_messages",
  {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").notNull(),
    vendorId: integer("vendor_id").references(() => vendors.id, {
      onDelete: "set null",
    }),
    direction: text("direction").notNull().default("in"), // in | out
    messageType: text("message_type").notNull().default("text"), // text|image|audio|document|system
    body: text("body"),
    caption: text("caption"),
    ocrText: text("ocr_text"),
    mediaId: text("media_id"),
    mediaUrl: text("media_url"),
    mimeType: text("mime_type"),
    fromPhone: text("from_phone"),
    profileName: text("profile_name"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    parseStatus: text("parse_status").notNull().default("pending"), // pending|parsed|review|failed|ignored
    parseConfidence: integer("parse_confidence").notNull().default(0),
    extractionSource: text("extraction_source"), // rules|vision|manual|audio
    parsePayload: jsonb("parse_payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("wa_messages_wa_id_uq").on(t.waMessageId),
    index("wa_messages_received_idx").on(t.receivedAt),
    index("wa_messages_vendor_idx").on(t.vendorId),
  ],
);

/** Ledger entries. credit = billed / amount payable grows. debit = paid / payable shrinks. */
export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    vendorId: integer("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    messageId: integer("message_id").references(() => waMessages.id, {
      onDelete: "set null",
    }),
    entryType: text("entry_type").notNull(), // credit | debit
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("PKR"),
    description: text("description"),
    reference: text("reference"),
    paymentMode: text("payment_mode"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dueDate: date("due_date"),
    status: text("status").notNull().default("confirmed"), // draft|confirmed|void
    source: text("source").notNull().default("whatsapp"), // whatsapp|manual|import
    confidence: integer("confidence").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tx_vendor_idx").on(t.vendorId),
    index("tx_occurred_idx").on(t.occurredAt),
    index("tx_type_idx").on(t.entryType),
  ],
);

export const txItems = pgTable(
  "tx_items",
  {
    id: serial("id").primaryKey(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sku: text("sku"),
    qty: doublePrecision("qty").notNull().default(1),
    unit: text("unit"),
    unitPriceMinor: bigint("unit_price_minor", { mode: "number" }),
    lineTotalMinor: bigint("line_total_minor", { mode: "number" }),
  },
  (t) => [index("tx_items_tx_idx").on(t.transactionId)],
);

/** Immutable event log for dispute resolution. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    action: text("action").notNull(),
    actor: text("actor").notNull().default("system"),
    summary: text("summary"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);

export const reportSnapshots = pgTable("report_snapshots", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").references(() => vendors.id, {
    onDelete: "cascade",
  }),
  periodType: text("period_type").notNull(), // weekly|monthly|yearly
  periodKey: text("period_key").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const reminders = pgTable("reminders", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id")
    .notNull()
    .references(() => vendors.id, { onDelete: "cascade" }),
  transactionId: integer("transaction_id").references(() => transactions.id, {
    onDelete: "set null",
  }),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  dueDate: date("due_date"),
  channel: text("channel").notNull().default("whatsapp"),
  status: text("status").notNull().default("queued"), // queued|sent|failed|simulated
  messageText: text("message_text").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Offline-tolerant retry queue for webhook deliveries / outbound sends. */
export const syncQueue = pgTable(
  "sync_queue",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // webhook|send|media
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending|done|failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sync_status_idx").on(t.status)],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Vendor = typeof vendors.$inferSelect;
export type WaMessage = typeof waMessages.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TxItem = typeof txItems.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;

/**
 * Bill photos uploaded straight from the app / iPhone Share Sheet (not via
 * WhatsApp). Stored as base64 text, already downsized by the client, so the
 * audit trail keeps the original picture. Referenced as mediaId "upload:<id>".
 */
export const mediaBlobs = pgTable("media_blobs", {
  id: serial("id").primaryKey(),
  mimeType: text("mime_type").notNull(),
  dataBase64: text("data_base64").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Other names / phone numbers a vendor is known by (Urdu shop name printed on bills, a second
 * mobile number...). Learned when a person assigns a bill to a vendor, so the next bill with the
 * same printed name or phone goes to that vendor by itself.
 */
export const vendorAliases = pgTable(
  "vendor_aliases",
  {
    id: serial("id").primaryKey(),
    vendorId: integer("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // name | phone
    alias: text("alias").notNull(), // as seen on the bill
    aliasNorm: text("alias_norm").notNull(), // lowercase text / last 10 digits
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vendor_aliases_uq").on(t.kind, t.aliasNorm), index("vendor_aliases_vendor_idx").on(t.vendorId)],
);

/**
 * Which payment (debit) settles which bill (credit), and how much. Lets a payment of Rs 5,000 be
 * applied to a specific bill of Rs 13,500 so each bill shows what is still open. Payments with no
 * explicit allocation still settle the oldest bills first (the existing aging rule).
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: serial("id").primaryKey(),
    paymentId: integer("payment_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    billId: integer("bill_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payment_alloc_uq").on(t.paymentId, t.billId), index("payment_alloc_bill_idx").on(t.billId)],
);

/** Web-push subscriptions (installed iPhone/Android app or desktop browser). */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  prefs: jsonb("prefs").notNull().default({ reviewNeeded: true, dueSoon: true, weekly: false }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
