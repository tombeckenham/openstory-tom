ALTER TABLE `styles` ADD `sample_videos` text;--> statement-breakpoint
ALTER TABLE `styles` ADD `recommended_image_model` text;--> statement-breakpoint
ALTER TABLE `styles` ADD `recommended_video_model` text;--> statement-breakpoint
ALTER TABLE `styles` ADD `default_aspect_ratio` text;--> statement-breakpoint
ALTER TABLE `styles` ADD `use_cases` text;--> statement-breakpoint
-- Backfill JSON-array columns so existing rows match the inferred non-null
-- TS types (`StyleSampleVideo[]` / `string[]`) instead of returning NULL.
UPDATE `styles` SET `sample_videos` = '[]' WHERE `sample_videos` IS NULL;--> statement-breakpoint
UPDATE `styles` SET `use_cases` = '[]' WHERE `use_cases` IS NULL;
