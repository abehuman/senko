CREATE TABLE "account_memberships" (
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_memberships_pk" PRIMARY KEY("account_id","user_id"),
	CONSTRAINT "account_memberships_role_check" CHECK ("account_memberships"."role" in ('owner', 'admin', 'billing', 'member')),
	CONSTRAINT "account_memberships_status_check" CHECK ("account_memberships"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"plan_key" varchar(64) DEFAULT 'beta' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_name_check" CHECK (length(btrim("accounts"."name")) > 0),
	CONSTRAINT "accounts_status_check" CHECK ("accounts"."status" in ('active', 'suspended', 'closed')),
	CONSTRAINT "accounts_plan_key_check" CHECK ("accounts"."plan_key" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "accounts_suspension_check" CHECK (("accounts"."status" = 'suspended' and "accounts"."suspended_at" is not null) or ("accounts"."status" <> 'suspended' and "accounts"."suspended_at" is null))
);
--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_user_id" uuid,
	"actor_api_key_id" uuid,
	"action" varchar(80) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(128),
	"request_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_events_actor_type_check" CHECK ("admin_audit_events"."actor_type" in ('system', 'user', 'api_key')),
	CONSTRAINT "admin_audit_events_actor_check" CHECK (("admin_audit_events"."actor_type" = 'system' and "admin_audit_events"."actor_user_id" is null and "admin_audit_events"."actor_api_key_id" is null) or ("admin_audit_events"."actor_type" = 'user' and "admin_audit_events"."actor_user_id" is not null and "admin_audit_events"."actor_api_key_id" is null) or ("admin_audit_events"."actor_type" = 'api_key' and "admin_audit_events"."actor_user_id" is null and "admin_audit_events"."actor_api_key_id" is not null)),
	CONSTRAINT "admin_audit_events_action_check" CHECK (length(btrim("admin_audit_events"."action")) > 0),
	CONSTRAINT "admin_audit_events_target_type_check" CHECK (length(btrim("admin_audit_events"."target_type")) > 0),
	CONSTRAINT "admin_audit_events_metadata_object_check" CHECK (jsonb_typeof("admin_audit_events"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "api_key_scopes" (
	"api_key_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"scope" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_scopes_pk" PRIMARY KEY("api_key_id","scope"),
	CONSTRAINT "api_key_scopes_scope_check" CHECK ("api_key_scopes"."scope" in ('models:read', 'inference:chat', 'inference:responses'))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"team_id" uuid,
	"name" varchar(120) NOT NULL,
	"public_id" varchar(32) NOT NULL,
	"key_prefix" varchar(24) NOT NULL,
	"key_hash" char(64) NOT NULL,
	"hash_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"rotation_group_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"replaces_api_key_id" uuid,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_id_account_id_unique" UNIQUE("id","account_id"),
	CONSTRAINT "api_keys_name_check" CHECK (length(btrim("api_keys"."name")) > 0),
	CONSTRAINT "api_keys_public_id_check" CHECK ("api_keys"."public_id" ~ '^[A-Za-z0-9_-]{16,32}$'),
	CONSTRAINT "api_keys_prefix_check" CHECK (length(btrim("api_keys"."key_prefix")) > 0),
	CONSTRAINT "api_keys_hash_check" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_hash_version_check" CHECK ("api_keys"."hash_version" > 0),
	CONSTRAINT "api_keys_status_check" CHECK ("api_keys"."status" in ('active', 'disabled', 'revoked')),
	CONSTRAINT "api_keys_expiry_check" CHECK ("api_keys"."expires_at" is null or "api_keys"."expires_at" > "api_keys"."created_at"),
	CONSTRAINT "api_keys_last_used_check" CHECK ("api_keys"."last_used_at" is null or "api_keys"."last_used_at" >= "api_keys"."created_at"),
	CONSTRAINT "api_keys_revocation_check" CHECK (("api_keys"."status" = 'revoked' and "api_keys"."revoked_at" is not null) or ("api_keys"."status" <> 'revoked' and "api_keys"."revoked_at" is null))
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"team_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memberships_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "team_memberships_role_check" CHECK ("team_memberships"."role" in ('admin', 'member')),
	CONSTRAINT "team_memberships_status_check" CHECK ("team_memberships"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_id_account_id_unique" UNIQUE("id","account_id"),
	CONSTRAINT "teams_name_check" CHECK (length(btrim("teams"."name")) > 0),
	CONSTRAINT "teams_status_check" CHECK ("teams"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"display_name" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'disabled', 'deleted')),
	CONSTRAINT "users_display_name_check" CHECK ("users"."display_name" is null or length(btrim("users"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_memberships" ADD CONSTRAINT "account_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_user_fk" FOREIGN KEY ("account_id","actor_user_id") REFERENCES "public"."account_memberships"("account_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_key_fk" FOREIGN KEY ("actor_api_key_id","account_id") REFERENCES "public"."api_keys"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_key_account_fk" FOREIGN KEY ("api_key_id","account_id") REFERENCES "public"."api_keys"("id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_account_fk" FOREIGN KEY ("team_id","account_id") REFERENCES "public"."teams"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_creator_account_member_fk" FOREIGN KEY ("account_id","created_by_user_id") REFERENCES "public"."account_memberships"("account_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_replaces_same_account_fk" FOREIGN KEY ("replaces_api_key_id","account_id") REFERENCES "public"."api_keys"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_account_fk" FOREIGN KEY ("team_id","account_id") REFERENCES "public"."teams"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_account_member_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account_memberships"("account_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_memberships_user_status_idx" ON "account_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "admin_audit_events_account_created_idx" ON "admin_audit_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_events_request_id_idx" ON "admin_audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "api_key_scopes_account_idx" ON "api_key_scopes" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_public_id_unique" ON "api_keys" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_account_status_idx" ON "api_keys" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "api_keys_team_status_idx" ON "api_keys" USING btree ("team_id","status");--> statement-breakpoint
CREATE INDEX "api_keys_rotation_group_idx" ON "api_keys" USING btree ("rotation_group_id");--> statement-breakpoint
CREATE INDEX "team_memberships_account_user_idx" ON "team_memberships" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE INDEX "teams_account_status_idx" ON "teams" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");