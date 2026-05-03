CREATE TABLE `character_sheet_variants` (
	`id` text PRIMARY KEY,
	`character_id` text NOT NULL,
	`model` text(100) NOT NULL,
	`url` text,
	`storage_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`diverged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_character_sheet_variants_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `location_sheet_variants` (
	`id` text PRIMARY KEY,
	`parent_type` text NOT NULL,
	`parent_id` text NOT NULL,
	`model` text(100) NOT NULL,
	`url` text,
	`storage_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`diverged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `talent_sheet_variants` (
	`id` text PRIMARY KEY,
	`talent_sheet_id` text NOT NULL,
	`model` text(100) NOT NULL,
	`url` text,
	`storage_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`generated_at` integer,
	`error` text,
	`input_hash` text,
	`diverged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_talent_sheet_variants_talent_sheet_id_talent_sheets_id_fk` FOREIGN KEY (`talent_sheet_id`) REFERENCES `talent_sheets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_character_sheet_variants_character` ON `character_sheet_variants` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `character_sheet_variants_primary_key` ON `character_sheet_variants` (`character_id`,`model`) WHERE "character_sheet_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `character_sheet_variants_divergent_key` ON `character_sheet_variants` (`character_id`,`model`,`input_hash`) WHERE "character_sheet_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_location_sheet_variants_parent` ON `location_sheet_variants` (`parent_type`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `location_sheet_variants_primary_key` ON `location_sheet_variants` (`parent_type`,`parent_id`,`model`) WHERE "location_sheet_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `location_sheet_variants_divergent_key` ON `location_sheet_variants` (`parent_type`,`parent_id`,`model`,`input_hash`) WHERE "location_sheet_variants"."diverged_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_talent_sheet_variants_talent_sheet` ON `talent_sheet_variants` (`talent_sheet_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `talent_sheet_variants_primary_key` ON `talent_sheet_variants` (`talent_sheet_id`,`model`) WHERE "talent_sheet_variants"."diverged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `talent_sheet_variants_divergent_key` ON `talent_sheet_variants` (`talent_sheet_id`,`model`,`input_hash`) WHERE "talent_sheet_variants"."diverged_at" IS NOT NULL;