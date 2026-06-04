ALTER TABLE "llm_calls" ADD COLUMN "tools" jsonb;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "response_tool_calls" jsonb;