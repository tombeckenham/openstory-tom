-- Issue #767: null prompt-input hashes after PROMPT_INPUT_HASH_VERSION bump (2 → 3).
--
-- Removing metadata.durationSeconds from the hashed scene context changes the
-- canonical body shape, so every previously-stored hash diverges from the
-- freshly-computed one. Without this sweep, legacy sequences would surface
-- false-positive "stale" banners on every Image / Motion tab.
--
-- Both staleness handlers (getFrameStalenessFn, regenerateFramePromptFn) treat
-- a null stored hash as 'untracked' (no opinion, no banner), so legacy rows
-- fall through that safe path until the user regenerates a prompt — which
-- restamps the columns with v3 hashes via the framePromptVariants.write path.
--
-- This is a column-data update, not a table rebuild, so it sidesteps the
-- D1 / Turso ON DELETE CASCADE trap documented in CLAUDE.md.
UPDATE `frames` SET `visual_prompt_input_hash` = NULL, `motion_prompt_input_hash` = NULL;
--> statement-breakpoint
UPDATE `frame_prompt_variants` SET `input_hash` = NULL;
