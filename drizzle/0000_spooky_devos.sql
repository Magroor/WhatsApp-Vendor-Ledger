CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer,
	"action" text NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"summary" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"transaction_id" integer,
	"amount_minor" bigint NOT NULL,
	"due_date" date,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"message_text" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer,
	"period_type" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"message_id" integer,
	"entry_type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"subtotal_minor" bigint,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'PKR' NOT NULL,
	"description" text,
	"reference" text,
	"payment_mode" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"source" text DEFAULT 'whatsapp' NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tx_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"qty" double precision DEFAULT 1 NOT NULL,
	"unit" text,
	"unit_price_minor" bigint,
	"line_total_minor" bigint
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"business_type" text,
	"city" text,
	"currency" text DEFAULT 'PKR' NOT NULL,
	"credit_terms_days" integer DEFAULT 30 NOT NULL,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"auto_create_source" text DEFAULT 'manual',
	"needs_review" boolean DEFAULT false NOT NULL,
	"notes" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"wa_message_id" text NOT NULL,
	"vendor_id" integer,
	"direction" text DEFAULT 'in' NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"body" text,
	"caption" text,
	"ocr_text" text,
	"media_id" text,
	"media_url" text,
	"mime_type" text,
	"from_phone" text,
	"profile_name" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parse_status" text DEFAULT 'pending' NOT NULL,
	"parse_confidence" integer DEFAULT 0 NOT NULL,
	"extraction_source" text,
	"parse_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_message_id_wa_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tx_items" ADD CONSTRAINT "tx_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "sync_status_idx" ON "sync_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tx_vendor_idx" ON "transactions" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "tx_occurred_idx" ON "transactions" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "tx_type_idx" ON "transactions" USING btree ("entry_type");--> statement-breakpoint
CREATE INDEX "tx_items_tx_idx" ON "tx_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "vendors_phone_idx" ON "vendors" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_messages_wa_id_uq" ON "wa_messages" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "wa_messages_received_idx" ON "wa_messages" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "wa_messages_vendor_idx" ON "wa_messages" USING btree ("vendor_id");