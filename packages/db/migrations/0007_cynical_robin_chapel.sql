ALTER TABLE "llm_calls" ADD COLUMN "tool_call_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
