/**
 * Diagnostic: dump recent frame rows from test.db to see workflow progress.
 * Run while a hung e2e test is still alive:
 *   bun --bun scripts/peek-test-frames.ts
 */

import { desc, sql } from 'drizzle-orm';
import { testDb } from '../e2e/fixtures/db-client';
import { frames, sequences } from '../src/lib/db/schema';

const recentFrames = await testDb
  .select({
    id: frames.id,
    seq: frames.sequenceId,
    thumb: frames.thumbnailStatus,
    video: frames.videoStatus,
    thumbErr: frames.thumbnailError,
    videoErr: frames.videoError,
    audio: sql<number>`CASE WHEN ${frames.audioUrl} IS NOT NULL THEN 1 ELSE 0 END`,
    created: frames.createdAt,
  })
  .from(frames)
  .orderBy(desc(frames.createdAt))
  .limit(20);

console.log('\n=== Most recent 20 frames ===');
console.table(recentFrames);

const recentSeqs = await testDb
  .select({
    id: sequences.id,
    title: sequences.title,
    musicUrl: sql<string>`COALESCE(${sequences.musicUrl}, '<none>')`,
    mergedVideoUrl: sql<string>`COALESCE(${sequences.mergedVideoUrl}, '<none>')`,
    posterUrl: sql<string>`COALESCE(${sequences.posterUrl}, '<none>')`,
    created: sequences.createdAt,
  })
  .from(sequences)
  .orderBy(desc(sequences.createdAt))
  .limit(3);

console.log('\n=== Most recent 3 sequences ===');
console.table(recentSeqs);

process.exit(0);
