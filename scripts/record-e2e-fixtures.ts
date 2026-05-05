#!/usr/bin/env bun
/**
 * Record fixtures for the full-sequence e2e test.
 *
 * Boots the e2e stack with FAL_RECORD=true and PLAYWRIGHT_FULL_PIPELINE=true,
 * then runs the full-sequence spec. The aimock server records OpenRouter
 * traffic and our fal-handler records fal.ai traffic. Subsequent runs without
 * these flags will replay from disk.
 *
 * Required env (in .env.local or shell):
 *   FAL_KEY        — real fal.ai API key
 *   OPENROUTER_KEY — real openrouter API key
 *
 * Run:
 *   bun scripts/record-e2e-fixtures.ts
 */

import { spawnSync } from 'node:child_process';

const required = ['FAL_KEY', 'OPENROUTER_KEY'] as const;
const missing = required.filter(
  (key) => !process.env[key] || process.env[key] === 'test-mock-key'
);
if (missing.length > 0) {
  console.error(
    `Missing real keys: ${missing.join(', ')}. Set them in .env.local before recording.`
  );
  process.exit(1);
}

const env = {
  ...process.env,
  PLAYWRIGHT_FULL_PIPELINE: 'true',
  FAL_RECORD: 'true',
  // aimock records OpenRouter automatically when CI is unset
  CI: '',
  // Don't open the HTML report — it spins up a server and blocks on Ctrl-C.
  PW_TEST_HTML_REPORT_OPEN: 'never',
};

const result = spawnSync('bun', ['test:e2e:full'], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
