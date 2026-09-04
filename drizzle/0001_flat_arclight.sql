ALTER TABLE "draft_items" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "token_iv" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "token_auth_tag" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_user_id_envelope_unique" ON "mcp_connections" USING btree ("user_id") WHERE "mcp_connections"."token_ciphertext" is not null;