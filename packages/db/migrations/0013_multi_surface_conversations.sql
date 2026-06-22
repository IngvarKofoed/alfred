CREATE TABLE IF NOT EXISTS "conversation_surfaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"external_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_surfaces_surface_external_key_unique" UNIQUE("surface","external_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_surface_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_surface_refs_message_surface_unique" UNIQUE("message_id","surface")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation_surfaces" ADD CONSTRAINT "conversation_surfaces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_surface_refs" ADD CONSTRAINT "message_surface_refs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_surfaces_conversation_idx" ON "conversation_surfaces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_surface_refs_message_idx" ON "message_surface_refs" USING btree ("message_id");--> statement-breakpoint
-- Backfill the Discord routing index from the about-to-be-dropped (ingress, channel_key) mapping:
-- every existing ingress='discord' conversation (a DM/guild post AND every per-fire watcher post
-- the bot repointed to ('discord', <post id>)) gets a conversation_surfaces(discord, channel_key)
-- row. Conversations still ingress='trigger' (a watcher whose fire never reached Discord — bot
-- down/unconfigured) get NO binding and resolve by id only (correct: they have no Discord presence).
-- The old unique(ingress, channel_key) guaranteed no two discord rows share a channel_key, so the
-- target unique(surface, external_key) cannot collide. ON CONFLICT DO NOTHING for re-run safety.
INSERT INTO "conversation_surfaces" ("id", "conversation_id", "surface", "external_key", "created_at")
SELECT gen_random_uuid(), "id", 'discord', "channel_key", now()
FROM "conversations"
WHERE "ingress" = 'discord'
ON CONFLICT ("surface", "external_key") DO NOTHING;--> statement-breakpoint
-- Drop the old routing/uniqueness key: Discord post→conversation resolution now lives in
-- conversation_surfaces. ingress + channel_key stay as origin metadata (ingress still drives
-- human_in_loop), just no longer unique. Guarded so a re-run is a no-op.
DO $$ BEGIN
 ALTER TABLE "conversations" DROP CONSTRAINT "conversations_ingress_channel_key_unique";
EXCEPTION
 WHEN undefined_object THEN null;
END $$;
