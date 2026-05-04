/**
 * Acceptance tests for the prompt-variants helpers.
 *
 * These exercise issue #620's acceptance criteria end-to-end against an
 * in-memory libSQL database with the real migrations applied:
 *   - Editing a prompt produces a `'user-edit'` row; the prior text is
 *     recoverable by reading the variant chain.
 *   - Regenerating a prompt produces a `'regenerated'` row with a populated
 *     `input_hash`.
 *   - The cached pointer (`frames.imagePrompt` / `motionPrompt` and the
 *     matching `*PromptInputHash`) is updated atomically by the helper.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  framePromptVariants,
  frames,
  sequenceMusicPromptVariants,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { eq } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createFramePromptVariantsMethods } from './frame-prompt-variants';
import { createSequenceMusicPromptVariantsMethods } from './sequence-music-prompt-variants';

type TestDb = LibSQLDatabase<Record<string, never>, typeof relations>;
const asDatabase = (testDb: TestDb): Database => testDb as unknown as Database;

let client: Client;
let db: TestDb;
let teamId = '';
let sequenceId = '';
let frameId = '';

async function seed() {
  await db.delete(framePromptVariants);
  await db.delete(sequenceMusicPromptVariants);
  await db.delete(frames);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  sequenceId = generateId();

  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
  const [frame] = await db
    .insert(frames)
    .values({ sequenceId, orderIndex: 0 })
    .returning();
  frameId = frame.id;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations, casing: 'snake_case' });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('frame_prompt_variants helper', () => {
  it('user-edit appends a row, updates cached column, and clears the input hash', async () => {
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    // Seed the cached column to mimic an existing AI-generated prompt.
    await db
      .update(frames)
      .set({
        imagePrompt: 'AI-generated prompt v1',
        visualPromptInputHash: 'hash-v1',
      })
      .where(eq(frames.id, frameId));

    const variant = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User edited prompt',
      source: 'user-edit',
    });

    expect(variant.source).toBe('user-edit');
    expect(variant.text).toBe('User edited prompt');
    expect(variant.inputHash).toBeNull();

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(refreshed.imagePrompt).toBe('User edited prompt');
    // user-edit clears the input hash since the cached value is no longer
    // derived from upstream context.
    expect(refreshed.visualPromptInputHash).toBeNull();
  });

  it('regenerated prompt populates input_hash on both the row and the cached column', async () => {
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    const variant = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v2',
      source: 'regenerated',
      inputHash: 'context-hash-abc',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(variant.source).toBe('regenerated');
    expect(variant.inputHash).toBe('context-hash-abc');

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(refreshed.imagePrompt).toBe('AI prompt v2');
    expect(refreshed.visualPromptInputHash).toBe('context-hash-abc');
  });

  it('preserves prior AI text in the variant chain after a user edit (recoverable history)', async () => {
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User edited prompt',
      source: 'user-edit',
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(2);
    // Newest first.
    expect(history[0].source).toBe('user-edit');
    expect(history[1].source).toBe('ai-generated');
    expect(history[1].text).toBe('AI prompt v1');
    expect(history[1].inputHash).toBe('context-hash-1');
  });

  it('ai-generated → regenerated → user-edit chain reflects the workflow source-discrimination flow', async () => {
    // Mirrors the scene-prompt workflow's decision: source = previous ?
    // 'regenerated' : 'ai-generated'. A regression that swaps the two would
    // mislabel every regeneration as a first generation (or vice versa) and
    // corrupt prompt history.
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    const previousBeforeFirst = await methods.getLatest(frameId, 'visual');
    expect(previousBeforeFirst).toBeNull();
    const firstSource = previousBeforeFirst ? 'regenerated' : 'ai-generated';

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: firstSource,
      inputHash: 'hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const previousBeforeSecond = await methods.getLatest(frameId, 'visual');
    expect(previousBeforeSecond?.source).toBe('ai-generated');
    const secondSource = previousBeforeSecond ? 'regenerated' : 'ai-generated';

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v2',
      source: secondSource,
      inputHash: 'hash-v2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User polished it',
      source: 'user-edit',
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history.map((r) => r.source)).toEqual([
      'user-edit',
      'regenerated',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    // Cached column reflects the latest write (user-edit) and the hash is
    // cleared since the cached value is no longer derived from upstream.
    expect(refreshed.imagePrompt).toBe('User polished it');
    expect(refreshed.visualPromptInputHash).toBeNull();
  });

  it('AI write is idempotent on (frame, type, input_hash) — a retry returns the existing row', async () => {
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    const first = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const retried = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(retried.id).toBe(first.id);

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(1);
  });

  it('a different input_hash produces a new row for the same frame+type', async () => {
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI v1',
      source: 'ai-generated',
      inputHash: 'hash-a',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI v2',
      source: 'regenerated',
      inputHash: 'hash-b',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(2);
  });

  it('motion prompts use the motionPrompt cached column independently of visual', async () => {
    const methods = createFramePromptVariantsMethods(asDatabase(db));

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'visual',
      source: 'ai-generated',
      inputHash: 'visual-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      frameId,
      promptType: 'motion',
      text: 'motion',
      source: 'ai-generated',
      inputHash: 'motion-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    expect(refreshed.imagePrompt).toBe('visual');
    expect(refreshed.motionPrompt).toBe('motion');
    expect(refreshed.visualPromptInputHash).toBe('visual-hash');
    expect(refreshed.motionPromptInputHash).toBe('motion-hash');
  });
});

describe('sequence_music_prompt_variants helper', () => {
  it('user-edit clears musicPromptInputHash and overwrites the cached prompt/tags', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(asDatabase(db));

    await db
      .update(sequences)
      .set({
        musicPrompt: 'AI music v1',
        musicTags: 'epic,cinematic',
        musicPromptInputHash: 'music-hash-1',
      })
      .where(eq(sequences.id, sequenceId));

    const variant = await methods.write({
      sequenceId,
      prompt: 'User edited music prompt',
      tags: 'rock,fast',
      source: 'user-edit',
    });

    expect(variant.source).toBe('user-edit');

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(refreshed.musicPrompt).toBe('User edited music prompt');
    expect(refreshed.musicTags).toBe('rock,fast');
    expect(refreshed.musicPromptInputHash).toBeNull();
  });

  it('ai-generated → regenerated chain on music variants mirrors the music-prompt workflow flow', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(asDatabase(db));

    const previousBeforeFirst = await methods.getLatest(sequenceId);
    expect(previousBeforeFirst).toBeNull();
    const firstSource = previousBeforeFirst ? 'regenerated' : 'ai-generated';

    await methods.write({
      sequenceId,
      prompt: 'AI music v1',
      tags: 'epic',
      source: firstSource,
      inputHash: 'music-hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const previousBeforeSecond = await methods.getLatest(sequenceId);
    expect(previousBeforeSecond?.source).toBe('ai-generated');
    const secondSource = previousBeforeSecond ? 'regenerated' : 'ai-generated';

    await methods.write({
      sequenceId,
      prompt: 'AI music v2',
      tags: 'epic,driving',
      source: secondSource,
      inputHash: 'music-hash-v2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listBySequence(sequenceId);
    expect(history.map((r) => r.source)).toEqual([
      'regenerated',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(refreshed.musicPrompt).toBe('AI music v2');
    expect(refreshed.musicPromptInputHash).toBe('music-hash-v2');
  });

  it('AI music write is idempotent on (sequence, input_hash) — a retry returns the existing row', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(asDatabase(db));

    const first = await methods.write({
      sequenceId,
      prompt: 'AI music',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const retried = await methods.write({
      sequenceId,
      prompt: 'AI music',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(retried.id).toBe(first.id);

    const history = await methods.listBySequence(sequenceId);
    expect(history).toHaveLength(1);
  });

  it('regenerated music prompt populates the input hash on the sequence row', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(asDatabase(db));

    await methods.write({
      sequenceId,
      prompt: 'AI music v2',
      tags: 'epic',
      source: 'regenerated',
      inputHash: 'music-context-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    expect(refreshed.musicPrompt).toBe('AI music v2');
    expect(refreshed.musicPromptInputHash).toBe('music-context-hash');
  });
});
