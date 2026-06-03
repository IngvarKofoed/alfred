CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"model" text NOT NULL,
	"request" jsonb NOT NULL,
	"response_text" text DEFAULT '' NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"finish_reason" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_run_created_idx" ON "llm_calls" USING btree ("agent_run_id","created_at");