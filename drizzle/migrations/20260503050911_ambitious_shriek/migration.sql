CREATE TABLE `frame_prompt_variants` (
	`id` text PRIMARY KEY,
	`frame_id` text NOT NULL,
	`prompt_type` text NOT NULL,
	`text` text NOT NULL,
	`components` text,
	`parameters` text,
	`source` text NOT NULL,
	`input_hash` text,
	`analysis_model` text(100),
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_frame_prompt_variants_frame_id_frames_id_fk` FOREIGN KEY (`frame_id`) REFERENCES `frames`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_frame_prompt_variants_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sequence_music_prompt_variants` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`prompt_type` text DEFAULT 'music' NOT NULL,
	`prompt` text NOT NULL,
	`tags` text,
	`components` text,
	`parameters` text,
	`source` text NOT NULL,
	`input_hash` text,
	`analysis_model` text(100),
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT `fk_sequence_music_prompt_variants_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_sequence_music_prompt_variants_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `frames` ADD `visual_prompt_input_hash` text;--> statement-breakpoint
ALTER TABLE `frames` ADD `motion_prompt_input_hash` text;--> statement-breakpoint
ALTER TABLE `sequences` ADD `music_prompt_input_hash` text;--> statement-breakpoint
CREATE INDEX `idx_frame_prompt_variants_frame_type_created` ON `frame_prompt_variants` (`frame_id`,`prompt_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sequence_music_prompt_variants_sequence_created` ON `sequence_music_prompt_variants` (`sequence_id`,`created_at`);