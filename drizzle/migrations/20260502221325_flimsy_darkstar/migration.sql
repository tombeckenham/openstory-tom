CREATE TABLE `sequence_music_variants` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`url` text,
	`storage_path` text,
	`prompt` text,
	`tags` text,
	`duration_seconds` integer,
	`model` text(100) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`diverged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_music_variants_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sequence_video_variants` (
	`id` text PRIMARY KEY,
	`sequence_id` text NOT NULL,
	`url` text,
	`storage_path` text,
	`workflow` text(100) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`diverged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sequence_video_variants_sequence_id_sequences_id_fk` FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_sequence_music_variants_sequence` ON `sequence_music_variants` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_music_variants_primary_key` ON `sequence_music_variants` (`sequence_id`,`model`) WHERE "sequence_music_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_music_variants_divergent_key` ON `sequence_music_variants` (`sequence_id`,`model`,`input_hash`) WHERE "sequence_music_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sequence_video_variants_sequence` ON `sequence_video_variants` (`sequence_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_video_variants_primary_key` ON `sequence_video_variants` (`sequence_id`,`workflow`) WHERE "sequence_video_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_video_variants_divergent_key` ON `sequence_video_variants` (`sequence_id`,`workflow`,`input_hash`) WHERE "sequence_video_variants"."diverged_at" IS NOT NULL;
