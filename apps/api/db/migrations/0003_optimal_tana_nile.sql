CREATE TABLE "request_traces" (
	"request_id" varchar(64) PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"endpoint" varchar(32) NOT NULL,
	"method" varchar(8) NOT NULL,
	"http_status" integer NOT NULL,
	"failure_category" varchar(32),
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "request_traces_request_id_check" CHECK ("request_traces"."request_id" ~ '^req_[0-9a-f]{32}$'),
	CONSTRAINT "request_traces_endpoint_check" CHECK ("request_traces"."endpoint" in ('models', 'chat_completions', 'responses')),
	CONSTRAINT "request_traces_method_check" CHECK ("request_traces"."method" in ('GET', 'POST')),
	CONSTRAINT "request_traces_http_status_check" CHECK ("request_traces"."http_status" between 100 and 599),
	CONSTRAINT "request_traces_failure_category_check" CHECK ("request_traces"."failure_category" is null or "request_traces"."failure_category" in ('admission', 'authentication', 'cancelled', 'configuration', 'internal', 'invalid_request', 'provider_protocol', 'provider_capacity', 'provider_rejected', 'provider_transport', 'quota', 'timeout', 'usage')),
	CONSTRAINT "request_traces_time_check" CHECK ("request_traces"."completed_at" >= "request_traces"."started_at")
);
--> statement-breakpoint
ALTER TABLE "request_traces" ADD CONSTRAINT "request_traces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_traces" ADD CONSTRAINT "request_traces_key_account_fk" FOREIGN KEY ("api_key_id","account_id") REFERENCES "public"."api_keys"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_traces_account_started_idx" ON "request_traces" USING btree ("account_id","started_at");--> statement-breakpoint
CREATE INDEX "request_traces_key_started_idx" ON "request_traces" USING btree ("api_key_id","started_at");--> statement-breakpoint
CREATE INDEX "request_traces_completed_idx" ON "request_traces" USING btree ("completed_at");