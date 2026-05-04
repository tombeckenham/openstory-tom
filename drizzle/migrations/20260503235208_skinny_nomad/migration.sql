PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`talent_id` text,
	`character_id` text NOT NULL,
	`name` text(255) NOT NULL,
	`age` text,
	`gender` text,
	`ethnicity` text,
	`physical_description` text,
	`standard_clothing` text,
	`distinguishing_features` text,
	`consistency_tag` text,
	`first_mention_scene_id` text,
	`first_mention_text` text,
	`first_mention_line` integer,
	`sheet_image_url` text,
	`sheet_image_path` text,
	`sheet_status` text DEFAULT 'pending' NOT NULL,
	`sheet_generated_at` integer,
	`sheet_error` text,
	`sheet_input_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `characters_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE,
	CONSTRAINT `characters_talent_id_talent_id_fk` FOREIGN KEY (`talent_id`) REFERENCES `talent`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_characters`(`id`, `sequence_id`, `talent_id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `consistency_tag`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `sheet_image_url`, `sheet_image_path`, `sheet_status`, `sheet_generated_at`, `sheet_error`, `sheet_input_hash`, `created_at`, `updated_at`) SELECT `id`, `sequence_id`, `talent_id`, `character_id`, `name`, `age`, `gender`, `ethnicity`, `physical_description`, `standard_clothing`, `distinguishing_features`, `consistency_tag`, `first_mention_scene_id`, `first_mention_text`, `first_mention_line`, `sheet_image_url`, `sheet_image_path`, `sheet_status`, `sheet_generated_at`, `sheet_error`, `sheet_input_hash`, `created_at`, `updated_at` FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
ALTER TABLE `__new_characters` RENAME TO `characters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_characters_sequence_id` ON `characters` (`sequence_id`);--> statement-breakpoint
CREATE INDEX `idx_characters_talent_id` ON `characters` (`talent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `characters_sequence_character_key` ON `characters` (`sequence_id`,`character_id`);