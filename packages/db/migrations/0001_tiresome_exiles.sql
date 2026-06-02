CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"status" text NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_conversation_started_idx" ON "agent_runs" USING btree ("conversation_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_active_status_idx" ON "agent_runs" USING btree ("status") WHERE status in ('pending', 'running', 'awaiting_approval');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_one_active_per_conversation" ON "agent_runs" USING btree ("conversation_id") WHERE status in ('pending', 'running', 'awaiting_approval');