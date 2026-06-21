DROP TABLE IF EXISTS "triggers";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"conversation_id" uuid,
	"schedule" text,
	"params" jsonb,
	"triage" jsonb,
	"objective" text NOT NULL,
	"notify_policy" text NOT NULL,
	"cursor" jsonb,
	"pending_cursor" jsonb,
	"next_fire_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"detection_cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_source_run_id_agent_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_enabled_next_fire_idx" ON "automations" USING btree ("enabled","next_fire_at");
