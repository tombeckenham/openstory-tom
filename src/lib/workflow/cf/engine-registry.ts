/**
 * Per-workflow engine selector.
 *
 * Maps each workflow trigger path (the URL fragment passed to
 * `triggerWorkflow`) to either the existing QStash engine or Cloudflare
 * Workflows. The default is always `'qstash'` — a workflow only flips to
 * `'cloudflare'` once its CF port lands and the binding exists.
 *
 * Two override mechanisms exist, evaluated in order:
 *   1. Explicit map entry in `WORKFLOW_ENGINES`
 *   2. Env-var override `CF_WORKFLOWS_ENABLED` — comma-separated list of
 *      workflow trigger paths to force onto CF (without the leading slash).
 *      Useful for canarying without redeploying. Set to `*` or `all` to
 *      route every workflow that has a CF binding registered onto CF
 *      (workflows without a binding fall back to QStash automatically via
 *      `resolveEngineForTrigger`).
 *
 * See docs/investigations/cloudflare-workflows.md §8 for the rollout shape.
 */

import { getEnv } from '#env';
import type { WorkflowEngine } from '@/lib/workflow/cf/types';

const WORKFLOW_ENGINES: Record<string, WorkflowEngine> = {
  // Default everything to QStash; flip leaves first as PoC scope expands.
  // Phase A pilot: image-workflow (leaf, demonstrates infrastructure).
};

function normaliseTriggerPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

type OverrideMatcher = { kind: 'all' } | { kind: 'set'; entries: Set<string> };

function readOverride(): OverrideMatcher {
  const raw = getEnv().CF_WORKFLOWS_ENABLED;
  if (!raw) return { kind: 'set', entries: new Set() };
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(normaliseTriggerPath);
  if (entries.includes('*') || entries.includes('all')) {
    return { kind: 'all' };
  }
  return { kind: 'set', entries: new Set(entries) };
}

export function getEngineForWorkflow(triggerPath: string): WorkflowEngine {
  const key = normaliseTriggerPath(triggerPath);
  const override = readOverride();
  if (override.kind === 'all') return 'cloudflare';
  if (override.entries.has(key)) return 'cloudflare';
  return WORKFLOW_ENGINES[key] ?? 'qstash';
}
