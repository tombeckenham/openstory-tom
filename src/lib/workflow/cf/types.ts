/**
 * Shared types for Cloudflare Workflows infrastructure.
 *
 * The runtime types (`WorkflowEntrypoint`, `WorkflowStep`, `WorkflowEvent`,
 * `Workflow`, `WorkflowInstance`) are declared globally by
 * `cloudflare-env.d.ts` via the wrangler runtime-types generator. We re-export
 * the binding type alias here so the rest of the app doesn't import the
 * generated global directly.
 */

/**
 * Worker env interface, kept narrow to the bindings CF Workflows reads.
 * The full env is declared globally in `cloudflare-env.d.ts` as
 * `Cloudflare.Env` — we re-export just the slice we need so this module
 * stays decoupled from the generated file.
 */
export type CloudflareEnv = Cloudflare.Env & {
  // Each binding is declared in `wrangler.jsonc` under `workflows[]` and
  // optional here because it only exists in CF-deployed builds — local
  // Node/Vercel runs don't bind workflows.
  IMAGE_WORKFLOW?: Workflow<unknown>;
  ELEMENT_VISION_WORKFLOW?: Workflow<unknown>;
  MUSIC_WORKFLOW?: Workflow<unknown>;
  MOTION_WORKFLOW?: Workflow<unknown>;
  MOTION_BATCH_WORKFLOW?: Workflow<unknown>;
  CHARACTER_SHEET_WORKFLOW?: Workflow<unknown>;
  LOCATION_SHEET_WORKFLOW?: Workflow<unknown>;
  LIBRARY_TALENT_SHEET_WORKFLOW?: Workflow<unknown>;
  LIBRARY_LOCATION_SHEET_WORKFLOW?: Workflow<unknown>;
  LOCATION_BIBLE_WORKFLOW?: Workflow<unknown>;
  SHOT_VARIANT_WORKFLOW?: Workflow<unknown>;
  UPSCALE_SHOT_VARIANT_WORKFLOW?: Workflow<unknown>;
  VISUAL_PROMPT_SCENE_WORKFLOW?: Workflow<unknown>;
  MOTION_PROMPT_SCENE_WORKFLOW?: Workflow<unknown>;
  MOTION_PROMPT_WORKFLOW?: Workflow<unknown>;
  MUSIC_PROMPT_WORKFLOW?: Workflow<unknown>;
  MOTION_MUSIC_PROMPTS_WORKFLOW?: Workflow<unknown>;
  RECAST_CHARACTER_WORKFLOW?: Workflow<unknown>;
  RECAST_LOCATION_WORKFLOW?: Workflow<unknown>;
  LOCATION_MATCHING_WORKFLOW?: Workflow<unknown>;
  TALENT_MATCHING_WORKFLOW?: Workflow<unknown>;
  CHARACTER_BIBLE_WORKFLOW?: Workflow<unknown>;
  VISUAL_PROMPT_WORKFLOW?: Workflow<unknown>;
  FRAME_IMAGES_WORKFLOW?: Workflow<unknown>;
  REGENERATE_FRAMES_WORKFLOW?: Workflow<unknown>;
  REPLACE_ELEMENT_WORKFLOW?: Workflow<unknown>;
  STORYBOARD_WORKFLOW?: Workflow<unknown>;
  ANALYZE_SCRIPT_WORKFLOW?: Workflow<unknown>;
  SCENE_SPLIT_WORKFLOW?: Workflow<unknown>;
};

/** Engine selector for the per-workflow rollout switch. */
export type WorkflowEngine = 'qstash' | 'cloudflare';
