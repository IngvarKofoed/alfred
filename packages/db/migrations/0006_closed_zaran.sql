CREATE TABLE IF NOT EXISTS "tools" (
	"name" text PRIMARY KEY NOT NULL,
	"tool_group" text,
	"trust_tier" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"require_approval" boolean,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tools_group_idx" ON "tools" USING btree ("tool_group");