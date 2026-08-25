CREATE TABLE "api_key_usage_buckets" (
	"api_key_id" uuid NOT NULL,
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
	CONSTRAINT "api_key_usage_buckets_pk" PRIMARY KEY("api_key_id","bucket_type","window_start"),
	CONSTRAINT "api_key_usage_buckets_type_check" CHECK ("api_key_usage_buckets"."bucket_type" in ('minute_tokens', 'day_cost', 'month_cost')),
	CONSTRAINT "api_key_usage_buckets_amounts_check" CHECK ("api_key_usage_buckets"."reserved_input_tokens" >= 0 and "api_key_usage_buckets"."reserved_output_tokens" >= 0 and "api_key_usage_buckets"."reserved_cost_microunits" >= 0 and "api_key_usage_buckets"."settled_input_tokens" >= 0 and "api_key_usage_buckets"."settled_output_tokens" >= 0 and "api_key_usage_buckets"."settled_cost_microunits" >= 0),
	CONSTRAINT "api_key_usage_buckets_dimension_check" CHECK (("api_key_usage_buckets"."bucket_type" = 'minute_tokens' and "api_key_usage_buckets"."reserved_cost_microunits" = 0 and "api_key_usage_buckets"."settled_cost_microunits" = 0) or ("api_key_usage_buckets"."bucket_type" in ('day_cost', 'month_cost') and "api_key_usage_buckets"."reserved_input_tokens" = 0 and "api_key_usage_buckets"."reserved_output_tokens" = 0 and "api_key_usage_buckets"."settled_input_tokens" = 0 and "api_key_usage_buckets"."settled_output_tokens" = 0))
);
--> statement-breakpoint
CREATE TABLE "api_key_usage_limits" (
	"api_key_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"currency" char(3) NOT NULL,
	"minute_input_tokens" bigint NOT NULL,
	"minute_output_tokens" bigint NOT NULL,
	"max_request_cost_microunits" bigint NOT NULL,
	"daily_cost_microunits" bigint NOT NULL,
	"monthly_cost_microunits" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_usage_limits_key_account_unique" UNIQUE("api_key_id","account_id"),
	CONSTRAINT "api_key_usage_limits_policy_version_check" CHECK (length(btrim("api_key_usage_limits"."policy_version")) > 0),
	CONSTRAINT "api_key_usage_limits_currency_check" CHECK ("api_key_usage_limits"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "api_key_usage_limits_minute_input_check" CHECK ("api_key_usage_limits"."minute_input_tokens" > 0),
	CONSTRAINT "api_key_usage_limits_minute_output_check" CHECK ("api_key_usage_limits"."minute_output_tokens" > 0),
	CONSTRAINT "api_key_usage_limits_max_request_cost_check" CHECK ("api_key_usage_limits"."max_request_cost_microunits" > 0),
	CONSTRAINT "api_key_usage_limits_daily_cost_check" CHECK ("api_key_usage_limits"."daily_cost_microunits" > 0),
	CONSTRAINT "api_key_usage_limits_monthly_cost_check" CHECK ("api_key_usage_limits"."monthly_cost_microunits" > 0),
	CONSTRAINT "api_key_usage_limits_cost_order_check" CHECK ("api_key_usage_limits"."max_request_cost_microunits" <= "api_key_usage_limits"."daily_cost_microunits" and "api_key_usage_limits"."daily_cost_microunits" <= "api_key_usage_limits"."monthly_cost_microunits")
);
--> statement-breakpoint
ALTER TABLE "usage_attempts" ADD COLUMN "api_key_policy_version" varchar(64);--> statement-breakpoint
ALTER TABLE "api_key_usage_buckets" ADD CONSTRAINT "api_key_usage_buckets_key_account_fk" FOREIGN KEY ("api_key_id","account_id") REFERENCES "public"."api_key_usage_limits"("api_key_id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage_limits" ADD CONSTRAINT "api_key_usage_limits_key_account_fk" FOREIGN KEY ("api_key_id","account_id") REFERENCES "public"."api_keys"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_usage_buckets_account_key_window_idx" ON "api_key_usage_buckets" USING btree ("account_id","api_key_id","window_start");--> statement-breakpoint
CREATE INDEX "api_key_usage_limits_account_idx" ON "api_key_usage_limits" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "usage_attempts" ADD CONSTRAINT "usage_attempts_api_key_policy_version_check" CHECK ("usage_attempts"."api_key_policy_version" is null or length(btrim("usage_attempts"."api_key_policy_version")) > 0);