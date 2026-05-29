DROP INDEX IF EXISTS `idx_sequence_video_variants_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `sequence_video_variants_primary_key`;--> statement-breakpoint
DROP INDEX IF EXISTS `sequence_video_variants_divergent_key`;--> statement-breakpoint
DROP TABLE `sequence_video_variants`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `merged_video_url`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `merged_video_path`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `merged_video_status`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `merged_video_generated_at`;--> statement-breakpoint
ALTER TABLE `sequences` DROP COLUMN `merged_video_error`;