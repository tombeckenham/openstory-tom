/**
 * Diff fal request bodies across record runs.
 *
 * The fal handler appends every record-mode upstream call to
 * e2e/fixtures/recorded/_debug-bodies.jsonl. After running the recorder
 * twice, run this script to see whether bodies (post-normalization) are
 * identical across runs for the same logical step.
 *
 * Output groups entries by (method, pathname). Within each group, entries
 * with the *same bodyHash* are stable — normalization is working for that
 * call. Entries with *different bodyHashes* show what's still drifting:
 * the script prints a unified diff of the normalized bodies so you can
 * see exactly which substring is non-deterministic.
 *
 *   bun --bun scripts/diff-fal-bodies.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Entry = {
  ts: string;
  targetHost: string;
  method: string;
  pathname: string;
  bodyHash: string;
  normalizedBody: string;
};

const LOG_PATH = resolve(
  import.meta.dirname,
  '../e2e/fixtures/recorded/_debug-bodies.jsonl'
);

if (!existsSync(LOG_PATH)) {
  console.error(`Debug log not found at ${LOG_PATH}`);
  console.error(
    'Run the recorder at least once with FAL_RECORD=true to populate it.'
  );
  process.exit(1);
}

function parseEntry(line: string): Entry {
  const obj: unknown = JSON.parse(line);
  if (
    typeof obj === 'object' &&
    obj !== null &&
    'ts' in obj &&
    typeof obj.ts === 'string' &&
    'targetHost' in obj &&
    typeof obj.targetHost === 'string' &&
    'method' in obj &&
    typeof obj.method === 'string' &&
    'pathname' in obj &&
    typeof obj.pathname === 'string' &&
    'bodyHash' in obj &&
    typeof obj.bodyHash === 'string' &&
    'normalizedBody' in obj &&
    typeof obj.normalizedBody === 'string'
  ) {
    return {
      ts: obj.ts,
      targetHost: obj.targetHost,
      method: obj.method,
      pathname: obj.pathname,
      bodyHash: obj.bodyHash,
      normalizedBody: obj.normalizedBody,
    };
  }
  throw new Error(`Malformed debug entry: ${line.slice(0, 200)}`);
}

const entries: Entry[] = readFileSync(LOG_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(parseEntry);

console.log(`Loaded ${entries.length} debug entries from ${LOG_PATH}\n`);

// Group by (method, pathname) — these are the logical steps.
const groups = new Map<string, Entry[]>();
for (const e of entries) {
  const key = `${e.method} ${e.pathname}`;
  const list = groups.get(key) ?? [];
  list.push(e);
  groups.set(key, list);
}

let stable = 0;
let drifting = 0;

for (const [key, group] of groups) {
  if (group.length < 2) continue; // need ≥2 calls to detect drift

  const uniqueHashes = new Set(group.map((g) => g.bodyHash));
  if (uniqueHashes.size === 1) {
    stable++;
    continue;
  }

  drifting++;
  console.log(`\n=== DRIFT: ${key} ===`);
  console.log(
    `  ${group.length} calls, ${uniqueHashes.size} unique hashes: ${[...uniqueHashes].join(', ')}`
  );

  // Show diff between the first two distinct bodies.
  const seen = new Map<string, string>();
  for (const e of group) {
    if (seen.has(e.bodyHash)) continue;
    seen.set(e.bodyHash, e.normalizedBody);
    if (seen.size === 2) break;
  }
  const [a, b] = [...seen.values()];
  if (a && b) {
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const max = Math.max(aLines.length, bLines.length);
    let shown = 0;
    for (let i = 0; i < max && shown < 6; i++) {
      if (aLines[i] !== bLines[i]) {
        console.log(`  - line ${i}:`);
        console.log(`    A: ${truncate(aLines[i] ?? '<missing>')}`);
        console.log(`    B: ${truncate(bLines[i] ?? '<missing>')}`);
        shown++;
      }
    }
    if (aLines.length === 1 && bLines.length === 1) {
      // Single-line bodies (e.g. JSON on one line) — show char-level diff.
      const diffStart = firstDiff(a, b);
      if (diffStart !== -1) {
        console.log(`  first divergence at char ${diffStart}:`);
        console.log(
          `    A: …${truncate(a.slice(Math.max(0, diffStart - 40), diffStart + 80))}…`
        );
        console.log(
          `    B: …${truncate(b.slice(Math.max(0, diffStart - 40), diffStart + 80))}…`
        );
      }
    }
  }
}

console.log(`\nSummary: ${stable} stable groups, ${drifting} drifting groups`);
console.log(
  drifting === 0
    ? '✓ All recorded calls produce stable hashes across runs.'
    : '✗ Some calls drift — see normalized-body diffs above.'
);

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function firstDiff(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}
