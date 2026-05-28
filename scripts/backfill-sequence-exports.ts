#!/usr/bin/env bun
/**
 * Backfill `sequence_exports` from `sequences.mergedVideoUrl`.
 *
 * The Mediabunny live-player + browser-export pipeline (issue #742) replaced
 * the server-merged MP4 with `sequence_exports`. Before the `mergedVideo*`
 * columns are dropped (issue #759 / part 4 of #751), copy existing completed
 * merged-video rows into `sequence_exports` so users keep their download.
 *
 * Idempotent: re-running inserts zero rows once the backfill is done — the
 * `(sequenceId, url)` existence check skips anything already migrated.
 *
 * Usage (mirrors `scripts/seed.ts`):
 *   bun scripts/backfill-sequence-exports.ts --local        # local.db
 *   bun scripts/backfill-sequence-exports.ts --test         # test.db
 *   bun scripts/backfill-sequence-exports.ts --d1           # Cloudflare D1 (HTTP)
 *   bun scripts/backfill-sequence-exports.ts                # Turso (TURSO_DATABASE_URL)
 *
 * Add `--dry-run` to print the planned inserts without writing.
 *
 * See plan: /Users/tom/.claude/plans/implement-github-issue-751-synchronous-unicorn.md
 */

import { createD1HttpClient } from '@/lib/db/client-d1-http';
import { generateId } from '@/lib/db/id';
import { sequenceExports, sequences } from '@/lib/db/schema';
import { createClient } from '@libsql/client';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';

type Db = ReturnType<typeof drizzle> | ReturnType<typeof createD1HttpClient>;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    local: args.includes('--local'),
    test: args.includes('--test'),
    d1: args.includes('--d1'),
    dryRun: args.includes('--dry-run'),
  };
}

function connect(flags: ReturnType<typeof parseArgs>): {
  db: Db;
  label: string;
} {
  if (flags.d1) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !databaseId || !token) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN are required for --d1'
      );
    }
    return {
      db: createD1HttpClient({ accountId, databaseId, token }),
      label: 'Cloudflare D1 (HTTP API)',
    };
  }
  if (flags.test) {
    return {
      db: drizzle({ client: createClient({ url: 'file:test.db' }) }),
      label: 'local test.db',
    };
  }
  if (flags.local) {
    return {
      db: drizzle({ client: createClient({ url: 'file:local.db' }) }),
      label: 'local local.db',
    };
  }
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (!tursoUrl) {
    throw new Error(
      'TURSO_DATABASE_URL is required (use --local for local.db, --d1 for Cloudflare D1)'
    );
  }
  return {
    db: drizzle({
      client: createClient({
        url: tursoUrl,
        ...(tursoToken && { authToken: tursoToken }),
      }),
    }),
    label: `Turso (${new URL(tursoUrl).host})`,
  };
}

async function backfill() {
  const flags = parseArgs();
  const { db, label } = connect(flags);

  console.log(`🗄️  Target: ${label}${flags.dryRun ? ' (dry run)' : ''}\n`);

  const completed = await db
    .select()
    .from(sequences)
    .where(
      and(
        isNotNull(sequences.mergedVideoUrl),
        eq(sequences.mergedVideoStatus, 'completed')
      )
    );

  console.log(`Found ${completed.length} completed merged-video sequences.\n`);

  let inserted = 0;
  let skippedExisting = 0;
  let skippedNoPath = 0;

  for (const row of completed) {
    // The where-clause should have filtered nulls, but the column is nullable
    // so TypeScript still narrows it as `string | null`.
    if (!row.mergedVideoUrl) {
      continue;
    }

    const existing = await db
      .select()
      .from(sequenceExports)
      .where(
        and(
          eq(sequenceExports.sequenceId, row.id),
          eq(sequenceExports.url, row.mergedVideoUrl)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      skippedExisting++;
      continue;
    }

    // `sequence_exports.storagePath` is NOT NULL. Historic rows occasionally
    // have a URL but no path — log and skip rather than guess, so the user
    // can decide whether to backfill paths manually.
    if (!row.mergedVideoPath) {
      console.warn(
        `[skip-no-path] sequence ${row.id} has mergedVideoUrl but no mergedVideoPath — inspect manually`
      );
      skippedNoPath++;
      continue;
    }

    const newRow = {
      id: generateId(),
      sequenceId: row.id,
      url: row.mergedVideoUrl,
      storagePath: row.mergedVideoPath,
      durationSeconds: null,
      sourceFramesHash: null,
      sourceMusicVariantId: null,
      createdAt: row.mergedVideoGeneratedAt ?? new Date(),
    };

    if (flags.dryRun) {
      console.log(`[dry-run] would insert export for sequence ${row.id}`);
    } else {
      await db.insert(sequenceExports).values(newRow);
      console.log(`[ok] inserted export for sequence ${row.id}`);
    }
    inserted++;
  }

  console.log(
    `\nDone. inserted=${inserted} skipped-existing=${skippedExisting} skipped-no-path=${skippedNoPath}`
  );
  if (flags.dryRun) {
    console.log('(dry-run: no rows were written)');
  }
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
