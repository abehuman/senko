CREATE TABLE "account_usage_buckets" (
	"account_id" uuid NOT NULL,
	"bucket_type" varchar(24) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"reserved_input_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_output_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_cost_microunits" bigint DEFAULT 0 NOT NULL,
	"settled_input_tokens" bigint DEFAULT 0 NOT NULL,
	"settled_output_tokens" bigint DEFAULT 0 NOT NULL,
	"settled_cost_microunits" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_usage_buckets_pk" PRIMARY KEY("account_id","bucket_type","window_start"),
	CONSTRAINT "account_usage_buckets_type_check" CHECK ("account_usage_buckets"."bucket_type" in ('minute_tokens', 'day_cost', 'month_cost')),
	CONSTRAINT "account_usage_buckets_amounts_check" CHECK ("account_usage_buckets"."reserved_input_tokens" >= 0 and "account_usage_buckets"."reserved_output_tokens" >= 0 and "account_usage_buckets"."reserved_cost_microunits" >= 0 and "account_usage_buckets"."settled_input_tokens" >= 0 and "account_usage_buckets"."settled_output_tokens" >= 0 and "account_usage_buckets"."settled_cost_microunits" >= 0),
	CONSTRAINT "account_usage_buckets_dimension_check" CHECK (("account_usage_buckets"."bucket_type" = 'minute_tokens' and "account_usage_buckets"."reserved_cost_microunits" = 0 and "account_usage_buckets"."settled_cost_microunits" = 0) or ("account_usage_buckets"."bucket_type" in ('day_cost', 'month_cost') and "account_usage_buckets"."reserved_input_tokens" = 0 and "account_usage_buckets"."reserved_output_tokens" = 0 and "account_usage_buckets"."settled_input_tokens" = 0 and "account_usage_buckets"."settled_output_tokens" = 0))
);
--> statement-breakpoint
CREATE TABLE "account_usage_limits" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"currency" char(3) NOT NULL,
	"minute_input_tokens" bigint NOT NULL,
	"minute_output_tokens" bigint NOT NULL,
	"max_request_cost_microunits" bigint NOT NULL,
	"daily_cost_microunits" bigint NOT NULL,
	"monthly_cost_microunits" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_usage_limits_policy_version_check" CHECK (length(btrim("account_usage_limits"."policy_version")) > 0),
	CONSTRAINT "account_usage_limits_currency_check" CHECK ("account_usage_limits"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "account_usage_limits_minute_input_check" CHECK ("account_usage_limits"."minute_input_tokens" > 0),
	CONSTRAINT "account_usage_limits_minute_output_check" CHECK ("account_usage_limits"."minute_output_tokens" > 0),
	CONSTRAINT "account_usage_limits_max_request_cost_check" CHECK ("account_usage_limits"."max_request_cost_microunits" > 0),
	CONSTRAINT "account_usage_limits_daily_cost_check" CHECK ("account_usage_limits"."daily_cost_microunits" > 0),
	CONSTRAINT "account_usage_limits_monthly_cost_check" CHECK ("account_usage_limits"."monthly_cost_microunits" > 0),
	CONSTRAINT "account_usage_limits_cost_order_check" CHECK ("account_usage_limits"."max_request_cost_microunits" <= "account_usage_limits"."daily_cost_microunits" and "account_usage_limits"."daily_cost_microunits" <= "account_usage_limits"."monthly_cost_microunits")
);
--> statement-breakpoint
CREATE TABLE "usage_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"provider_attempt" integer DEFAULT 0 NOT NULL,
	"account_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"protocol" varchar(32) NOT NULL,
	"requested_model" varchar(160) NOT NULL,
	"resolved_model" varchar(160) NOT NULL,
	"provider_route" varchar(128) NOT NULL,
	"pricing_version" varchar(64) NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"currency" char(3) NOT NULL,
	"input_price_microunits_per_million_tokens" bigint NOT NULL,
	"output_price_microunits_per_million_tokens" bigint NOT NULL,
	"estimator_version" varchar(64) NOT NULL,
	"estimated_input_tokens" bigint NOT NULL,
	"reserved_output_tokens" bigint NOT NULL,
	"reserved_cost_microunits" bigint NOT NULL,
	"minute_window_start" timestamp with time zone NOT NULL,
	"day_window_start" timestamp with time zone NOT NULL,
	"month_window_start" timestamp with time zone NOT NULL,
	"reservation_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_attempts_id_account_id_unique" UNIQUE("id","account_id"),
	CONSTRAINT "usage_attempts_request_provider_attempt_unique" UNIQUE("request_id","provider_attempt"),
	CONSTRAINT "usage_attempts_request_id_check" CHECK ("usage_attempts"."request_id" ~ '^req_[0-9a-f]{32}$'),
	CONSTRAINT "usage_attempts_provider_attempt_check" CHECK ("usage_attempts"."provider_attempt" >= 0),
	CONSTRAINT "usage_attempts_protocol_check" CHECK ("usage_attempts"."protocol" in ('openai-completions', 'openai-responses')),
	CONSTRAINT "usage_attempts_requested_model_check" CHECK (length(btrim("usage_attempts"."requested_model")) > 0),
	CONSTRAINT "usage_attempts_resolved_model_check" CHECK (length(btrim("usage_attempts"."resolved_model")) > 0),
	CONSTRAINT "usage_attempts_provider_route_check" CHECK (length(btrim("usage_attempts"."provider_route")) > 0),
	CONSTRAINT "usage_attempts_pricing_version_check" CHECK (length(btrim("usage_attempts"."pricing_version")) > 0),
	CONSTRAINT "usage_attempts_policy_version_check" CHECK (length(btrim("usage_attempts"."policy_version")) > 0),
	CONSTRAINT "usage_attempts_currency_check" CHECK ("usage_attempts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "usage_attempts_estimator_version_check" CHECK (length(btrim("usage_attempts"."estimator_version")) > 0),
	CONSTRAINT "usage_attempts_price_check" CHECK ("usage_attempts"."input_price_microunits_per_million_tokens" >= 0 and "usage_attempts"."output_price_microunits_per_million_tokens" >= 0),
	CONSTRAINT "usage_attempts_estimated_input_check" CHECK ("usage_attempts"."estimated_input_tokens" >= 0),
	CONSTRAINT "usage_attempts_reserved_output_check" CHECK ("usage_attempts"."reserved_output_tokens" > 0),
	CONSTRAINT "usage_attempts_reserved_cost_check" CHECK ("usage_attempts"."reserved_cost_microunits" >= 0),
	CONSTRAINT "usage_attempts_reservation_expiry_check" CHECK ("usage_attempts"."reservation_expires_at" > "usage_attempts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "usage_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"phase" varchar(24) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"reserved_input_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_output_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_cost_microunits" bigint DEFAULT 0 NOT NULL,
	"released_input_tokens" bigint DEFAULT 0 NOT NULL,
	"released_output_tokens" bigint DEFAULT 0 NOT NULL,
	"released_cost_microunits" bigint DEFAULT 0 NOT NULL,
	"settled_input_tokens" bigint DEFAULT 0 NOT NULL,
	"settled_output_tokens" bigint DEFAULT 0 NOT NULL,
	"settled_cost_microunits" bigint DEFAULT 0 NOT NULL,
	"usage_source" varchar(24) NOT NULL,
	"terminal_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_entries_attempt_phase_unique" UNIQUE("attempt_id","phase"),
	CONSTRAINT "usage_ledger_entries_phase_check" CHECK ("usage_ledger_entries"."phase" in ('reservation', 'terminal', 'reconciliation')),
	CONSTRAINT "usage_ledger_entries_event_type_check" CHECK ("usage_ledger_entries"."event_type" in ('reserved', 'settled', 'released', 'conservative_settled', 'reconciled')),
	CONSTRAINT "usage_ledger_entries_usage_source_check" CHECK ("usage_ledger_entries"."usage_source" in ('none', 'provider', 'reservation', 'reconciliation')),
	CONSTRAINT "usage_ledger_entries_amounts_check" CHECK ("usage_ledger_entries"."reserved_input_tokens" >= 0 and "usage_ledger_entries"."reserved_output_tokens" >= 0 and "usage_ledger_entries"."reserved_cost_microunits" >= 0 and "usage_ledger_entries"."released_input_tokens" >= 0 and "usage_ledger_entries"."released_output_tokens" >= 0 and "usage_ledger_entries"."released_cost_microunits" >= 0 and "usage_ledger_entries"."settled_input_tokens" >= 0 and "usage_ledger_entries"."settled_output_tokens" >= 0 and "usage_ledger_entries"."settled_cost_microunits" >= 0),
	CONSTRAINT "usage_ledger_entries_phase_event_check" CHECK (("usage_ledger_entries"."phase" = 'reservation' and "usage_ledger_entries"."event_type" = 'reserved' and "usage_ledger_entries"."usage_source" = 'none' and "usage_ledger_entries"."terminal_reason" is null and "usage_ledger_entries"."reserved_output_tokens" > 0 and "usage_ledger_entries"."released_input_tokens" = 0 and "usage_ledger_entries"."released_output_tokens" = 0 and "usage_ledger_entries"."released_cost_microunits" = 0 and "usage_ledger_entries"."settled_input_tokens" = 0 and "usage_ledger_entries"."settled_output_tokens" = 0 and "usage_ledger_entries"."settled_cost_microunits" = 0) or ("usage_ledger_entries"."phase" = 'terminal' and "usage_ledger_entries"."event_type" in ('settled', 'released', 'conservative_settled') and "usage_ledger_entries"."usage_source" in ('provider', 'reservation', 'none') and "usage_ledger_entries"."terminal_reason" is not null and "usage_ledger_entries"."reserved_input_tokens" = 0 and "usage_ledger_entries"."reserved_output_tokens" = 0 and "usage_ledger_entries"."reserved_cost_microunits" = 0) or ("usage_ledger_entries"."phase" = 'reconciliation' and "usage_ledger_entries"."event_type" = 'reconciled' and "usage_ledger_entries"."usage_source" = 'reconciliation' and "usage_ledger_entries"."terminal_reason" is not null and "usage_ledger_entries"."reserved_input_tokens" = 0 and "usage_ledger_entries"."reserved_output_tokens" = 0 and "usage_ledger_entries"."reserved_cost_microunits" = 0))
);
--> statement-breakpoint
ALTER TABLE "account_usage_buckets" ADD CONSTRAINT "account_usage_buckets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_usage_limits" ADD CONSTRAINT "account_usage_limits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_attempts" ADD CONSTRAINT "usage_attempts_key_account_fk" FOREIGN KEY ("api_key_id","account_id") REFERENCES "public"."api_keys"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_attempt_account_fk" FOREIGN KEY ("attempt_id","account_id") REFERENCES "public"."usage_attempts"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_usage_buckets_account_window_idx" ON "account_usage_buckets" USING btree ("account_id","window_start");--> statement-breakpoint
CREATE INDEX "usage_attempts_account_created_idx" ON "usage_attempts" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_attempts_key_created_idx" ON "usage_attempts" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_entries_account_created_idx" ON "usage_ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_entries_attempt_created_idx" ON "usage_ledger_entries" USING btree ("attempt_id","created_at");