/**
 * Maps trigger paths (the URL fragment passed to `triggerWorkflow`) to the
 * env binding name declared in `wrangler.jsonc`. Only workflows with a CF
 * port appear here — the rest stay on QStash.
 *
 * To add a new CF-backed workflow:
 *   1. Add the `class_name` + `binding` to `wrangler.jsonc` under `workflows[]`
 *   2. Re-export the entrypoint class from `src/server.ts` so the bundler
 *      includes it.
 *   3. Add an entry here.
 *   4. (Optional) Flip it on by default in `engine-registry.ts`, or canary
 *      via the `CF_WORKFLOWS_ENABLED` env var.
 */

import type { CloudflareEnv, WorkflowEngine } from '@/lib/workflow/cf/types';
import { buildInstanceId } from '@/lib/workflow/cf/instance-id';
import { getEngineForWorkflow } from '@/lib/workflow/cf/engine-registry';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'cf', 'trigger-bindings']);

const TRIGGER_TO_BINDING: Record<string, keyof CloudflareEnv> = {
  image: 'IMAGE_WORKFLOW',
  'element-vision': 'ELEMENT_VISION_WORKFLOW',
  music: 'MUSIC_WORKFLOW',
  motion: 'MOTION_WORKFLOW',
  'motion-batch': 'MOTION_BATCH_WORKFLOW',
  'character-sheet': 'CHARACTER_SHEET_WORKFLOW',
  'location-sheet': 'LOCATION_SHEET_WORKFLOW',
  'library-talent-sheet': 'LIBRARY_TALENT_SHEET_WORKFLOW',
  'library-location-sheet': 'LIBRARY_LOCATION_SHEET_WORKFLOW',
  'variant-image': 'SHOT_VARIANT_WORKFLOW',
  'upscale-variant': 'UPSCALE_SHOT_VARIANT_WORKFLOW',
  'visual-prompt-scene': 'VISUAL_PROMPT_SCENE_WORKFLOW',
  'motion-prompt-scene': 'MOTION_PROMPT_SCENE_WORKFLOW',
  'music-prompt': 'MUSIC_PROMPT_WORKFLOW',
  'recast-character': 'RECAST_CHARACTER_WORKFLOW',
  'location-matching': 'LOCATION_MATCHING_WORKFLOW',
  'frame-images': 'FRAME_IMAGES_WORKFLOW',
  'talent-matching': 'TALENT_MATCHING_WORKFLOW',
  'character-sheet-from-bible': 'CHARACTER_BIBLE_WORKFLOW',
  'location-sheet-from-bible': 'LOCATION_BIBLE_WORKFLOW',
  'visual-prompts': 'VISUAL_PROMPT_WORKFLOW',
  'motion-prompts': 'MOTION_PROMPT_WORKFLOW',
  'motion-music-prompts': 'MOTION_MUSIC_PROMPTS_WORKFLOW',
  'regenerate-frames': 'REGENERATE_FRAMES_WORKFLOW',
  'recast-location': 'RECAST_LOCATION_WORKFLOW',
  'replace-element': 'REPLACE_ELEMENT_WORKFLOW',
  'scene-split': 'SCENE_SPLIT_WORKFLOW',
  storyboard: 'STORYBOARD_WORKFLOW',
  'analyze-script': 'ANALYZE_SCRIPT_WORKFLOW',
};

export type CfTriggerResult = { workflowRunId: string };

/**
 * Look up the CF binding for a trigger path. Returns null when the workflow
 * isn't CF-backed.
 */
export function getCfBindingForTriggerPath(
  triggerPath: string,
  env: CloudflareEnv
): Workflow<unknown> | null {
  const key = triggerPath.startsWith('/') ? triggerPath.slice(1) : triggerPath;
  const bindingName = TRIGGER_TO_BINDING[key];
  if (!bindingName) return null;
  const binding = env[bindingName];
  if (!binding || typeof binding !== 'object' || !('create' in binding)) {
    throw new Error(
      `[triggerWorkflow] CF engine selected for '${key}' but env binding '${String(bindingName)}' is missing or not a Workflow binding. ` +
        `Check wrangler.jsonc and ensure 'bun cf:typegen' has been run.`
    );
  }
  return binding;
}

/**
 * Decide which engine to use for a given trigger path. Pure — no side
 * effects, safe to call before doing any work. Bundles the engine choice
 * with the env binding lookup so `triggerWorkflow` only has one place to
 * branch.
 */
export function resolveEngineForTrigger(
  triggerPath: string,
  env: CloudflareEnv
): { engine: WorkflowEngine; binding: Workflow<unknown> | null } {
  const engine = getEngineForWorkflow(triggerPath);
  if (engine !== 'cloudflare') return { engine, binding: null };

  const binding = getCfBindingForTriggerPath(triggerPath, env);
  if (!binding) {
    // Registry says CF but no binding registered — fall back so the system
    // stays available; log loudly so it's obvious in production.
    logger.warn(
      `[triggerWorkflow] engine=cloudflare for '${triggerPath}' but no binding map entry found; falling back to qstash`
    );
    return { engine: 'qstash', binding: null };
  }
  return { engine, binding };
}

/**
 * Trigger a CF-backed workflow.
 */
export async function triggerCfWorkflow<T extends Rpc.Serializable<T>>({
  binding,
  triggerPath,
  body,
  env,
  deduplicationId,
}: {
  binding: Workflow<T>;
  triggerPath: string;
  body: T;
  env: CloudflareEnv;
  deduplicationId?: string;
}): Promise<CfTriggerResult> {
  const workflowName = triggerPath.startsWith('/')
    ? triggerPath.slice(1)
    : triggerPath;
  const id = buildInstanceId({
    env,
    workflowName,
    suffix: deduplicationId ?? `${Date.now()}-${crypto.randomUUID()}`,
  });

  const instance = await binding.create({ id, params: body });
  return { workflowRunId: instance.id };
}
