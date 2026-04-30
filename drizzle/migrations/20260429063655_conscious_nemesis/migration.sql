ALTER TABLE `characters` ADD `sheet_input_hash` text;--> statement-breakpoint
ALTER TABLE `frame_variants` ADD `input_hash` text;--> statement-breakpoint
ALTER TABLE `frame_variants` ADD `diverged_at` integer;--> statement-breakpoint
ALTER TABLE `frames` ADD `thumbnail_input_hash` text;--> statement-breakpoint
ALTER TABLE `frames` ADD `variant_image_input_hash` text;--> statement-breakpoint
ALTER TABLE `frames` ADD `video_input_hash` text;--> statement-breakpoint
ALTER TABLE `frames` ADD `audio_input_hash` text;--> statement-breakpoint
ALTER TABLE `location_library` ADD `reference_input_hash` text;--> statement-breakpoint
ALTER TABLE `location_sheets` ADD `input_hash` text;--> statement-breakpoint
ALTER TABLE `talent_sheets` ADD `input_hash` text;