/**
 * Cloudflare Workflows instance ID generation.
 *
 * CF Workflow instance IDs are global per Worker script. Two deployments
 * sharing the same script (production + PR previews) would collide if they
 * used the same ID. We namespace every ID with an environment slug derived
 * from `VITE_APP_URL` so PR-preview deployments cannot see each other's
 * instances or production's.
 *
 * See docs/investigations/cloudflare-workflows.md §4 Gap F.
 */

const MAX_INSTANCE_ID_LENGTH = 100;

/**
 * Derive a stable, filesystem-safe environment slug from `VITE_APP_URL`.
 *
 * Production: `openstory.so` → `openstory-so`
 * Preview:    `pr-123.openstory.dev` → `pr-123-openstory-dev`
 * Local:      unset → `local`
 */
export function getEnvironmentSlug(env: { VITE_APP_URL?: string }): string {
  const url = env.VITE_APP_URL;
  if (!url) return 'local';
  try {
    return new URL(url).host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } catch {
    return 'local';
  }
}

/**
 * Build an instance ID of the form `${envSlug}:${workflowName}:${suffix}`.
 *
 * The suffix is whatever the caller wants to deduplicate on
 * (e.g. `${sequenceId}:${frameId}` for image-workflow). The envSlug prefix
 * is what isolates PR-preview deployments from each other and from prod.
 *
 * Truncates to 100 chars (CF limit). Truncation happens at the suffix
 * because the env slug + workflow name are needed for namespacing and the
 * suffix is the dedup key — if it gets cut, the worst case is two callers
 * with very similar suffixes colliding (already the same in QStash today).
 */
export function buildInstanceId({
  env,
  workflowName,
  suffix,
}: {
  env: { VITE_APP_URL?: string };
  workflowName: string;
  suffix: string;
}): string {
  const envSlug = getEnvironmentSlug(env);
  const prefix = `${envSlug}:${workflowName}:`;
  const room = MAX_INSTANCE_ID_LENGTH - prefix.length;
  if (room <= 0) {
    throw new Error(
      `Instance ID prefix '${prefix}' exceeds the ${MAX_INSTANCE_ID_LENGTH}-char limit; shorten the env slug or workflow name`
    );
  }
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9:_-]+/g, '-');
  return `${prefix}${safeSuffix.slice(0, room)}`;
}
