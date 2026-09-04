ALTER TABLE "draft_items" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "draft_items" ADD COLUMN "display_ratio" double precision;--> statement-breakpoint
ALTER TABLE "draft_items" ADD COLUMN "special_price" double precision;--> statement-breakpoint
ALTER TABLE "draft_items" ADD COLUMN "promotions" jsonb;--> statement-breakpoint
UPDATE "draft_items" SET "display_ratio" = 1 WHERE "display_ratio" IS NULL;--> statement-breakpoint
UPDATE "draft_items" SET "promotions" = '[]'::jsonb WHERE "promotions" IS NULL;