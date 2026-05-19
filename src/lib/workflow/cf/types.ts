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
  /**
   * Image workflow binding. Declared in `wrangler.jsonc` under `workflows[]`.
   * Optional at the type level because the binding only exists in CF-deployed
   * builds — local Node/Vercel runs do not have it.
   */
  IMAGE_WORKFLOW?: Workflow<unknown>;
};

/** Engine selector for the per-workflow rollout switch. */
export type WorkflowEngine = 'qstash' | 'cloudflare';
