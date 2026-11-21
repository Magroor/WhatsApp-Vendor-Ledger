CREATE TABLE "vendor_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"kind" text NOT NULL,
	"alias" text NOT NULL,
	"alias_norm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_aliases" ADD CONSTRAINT "vendor_aliases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_aliases_uq" ON "vendor_aliases" USING btree ("kind","alias_norm");--> statement-breakpoint
CREATE INDEX "vendor_aliases_vendor_idx" ON "vendor_aliases" USING btree ("vendor_id");