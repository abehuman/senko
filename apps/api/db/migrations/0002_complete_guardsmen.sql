CREATE TABLE "usage_pending_reservations" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_pending_reservations" ADD CONSTRAINT "usage_pending_reservations_attempt_account_fk" FOREIGN KEY ("attempt_id","account_id") REFERENCES "public"."usage_attempts"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_pending_reservations_expiry_idx" ON "usage_pending_reservations" USING btree ("expires_at","attempt_id");