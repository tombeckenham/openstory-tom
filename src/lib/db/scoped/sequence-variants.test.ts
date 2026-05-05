/**
 * Schema-level acceptance tests for the partial-index split on
 * `sequence_video_variants` and `sequence_music_variants`, plus the divergence
 * routing in `writeVideoVariant` / `writeMusicVariant` (the contract that keeps
 * a re-run with a different `inputHash` from silently replacing the previous
 * primary).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { generateId } from '@/lib/db/id';
import {
  sequenceMusicVariants,
  sequenceVideoVariants,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createSequenceVariantsMethods } from './sequence-variants';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';

async function seed() {
  await db.delete(sequenceVideoVariants);
  await db.delete(sequenceMusicVariants);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();
  sequenceId = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
  const [style] = await db
    .insert(styles)
    .values({
      teamId: team.id,
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
  await db
    .insert(sequences)
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
    ]);
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

describe('sequence_video_variants partial-index uniqueness', () => {
  it('allows one primary plus N divergent alternates per (sequence, workflow)', async () => {
    await db.insert(sequenceVideoVariants).values({
      sequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/primary.mp4',
      status: 'completed',
      inputHash: 'primary-hash',
    });
    await db.insert(sequenceVideoVariants).values({
      sequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/divergent-a.mp4',
      status: 'completed',
      inputHash: 'divergent-hash-a',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    await db.insert(sequenceVideoVariants).values({
      sequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/divergent-b.mp4',
      status: 'completed',
      inputHash: 'divergent-hash-b',
      divergedAt: new Date('2026-04-30T00:00:00Z'),
    });

    const rows = await db.select().from(sequenceVideoVariants);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.divergedAt === null)).toHaveLength(1);
  });

  it('rejects a second primary for the same (sequence, workflow)', async () => {
    await db.insert(sequenceVideoVariants).values({
      sequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/p1.mp4',
      status: 'completed',
    });
    let threw = false;
    try {
      await db.insert(sequenceVideoVariants).values({
        sequenceId,
        workflow: 'merge-video',
        url: 'https://example.com/p2.mp4',
        status: 'completed',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('createSequenceVariantsMethods — video', () => {
  it('writeVideoVariant routes to primary when no existing primary', async () => {
    const methods = createSequenceVariantsMethods(db);
    const { variant, divergent } = await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/v.mp4',
      storagePath: '/path/v.mp4',
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'hash-1',
    });
    expect(divergent).toBe(false);
    expect(variant.divergedAt).toBeNull();
  });

  it('writeVideoVariant overwrites the primary when inputHash matches', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/v1.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'hash-1',
    });
    const second = await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/v1-resigned.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'hash-1',
    });
    expect(second.divergent).toBe(false);
    const all = await db.select().from(sequenceVideoVariants);
    expect(all).toHaveLength(1);
    expect(all[0].url).toBe('https://example.com/v1-resigned.mp4');
  });

  it('writeVideoVariant forks to divergent when currentHash differs from inputHash (within-run drift)', async () => {
    const methods = createSequenceVariantsMethods(db);
    // No prior primary; the only divergence signal is within-run drift.
    const result = await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/drifted.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'snapshot-hash',
      currentHash: 'live-hash',
    });
    expect(result.divergent).toBe(true);
    expect(result.variant.divergedAt).not.toBeNull();
    // The divergent row stores the trigger-time snapshot (idempotent on retry).
    expect(result.variant.inputHash).toBe('snapshot-hash');

    const primary = await methods.getVideoPrimary(sequenceId, 'merge-video');
    expect(primary).toBeNull();
  });

  it('writeVideoVariant routes to primary when currentHash equals inputHash', async () => {
    const methods = createSequenceVariantsMethods(db);
    const result = await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/converged.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'same-hash',
      currentHash: 'same-hash',
    });
    expect(result.divergent).toBe(false);
    expect(result.variant.divergedAt).toBeNull();
  });

  it('writeVideoVariant forks to divergent when existing primary has different hash', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/v1.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'hash-1',
    });
    const second = await methods.writeVideoVariant({
      sequenceId,
      url: 'https://example.com/v2.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'hash-2',
    });
    expect(second.divergent).toBe(true);
    expect(second.variant.divergedAt).not.toBeNull();

    const primary = await methods.getVideoPrimary(sequenceId, 'merge-video');
    expect(primary?.url).toBe('https://example.com/v1.mp4');
    expect(primary?.inputHash).toBe('hash-1');
  });

  it('insertDivergentVideo is idempotent on retry', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.upsertVideoPrimary({
      sequenceId,
      url: 'https://example.com/p.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'primary',
    });
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const first = await methods.insertDivergentVideo({
      sequenceId,
      url: 'https://example.com/d.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'd-hash',
      divergedAt,
    });
    const second = await methods.insertDivergentVideo({
      sequenceId,
      url: 'https://example.com/d.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'd-hash',
      divergedAt,
    });
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(sequenceVideoVariants);
    expect(rows.filter((r) => r.divergedAt !== null)).toHaveLength(1);
  });

  it('upsertVideoPrimary respects the divergedAt IS NULL partial unique index', async () => {
    const methods = createSequenceVariantsMethods(db);

    // A divergent row exists; upsert must still succeed against the primary slot.
    await db.insert(sequenceVideoVariants).values({
      sequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/d.mp4',
      status: 'completed',
      inputHash: 'd',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const variant = await methods.upsertVideoPrimary({
      sequenceId,
      url: 'https://example.com/p.mp4',
      storagePath: null,
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'p',
    });
    expect(variant.divergedAt).toBeNull();
    const all = await db.select().from(sequenceVideoVariants);
    expect(all).toHaveLength(2);
  });

  it('promoteVideoVariant copies a divergent variant onto sequences.mergedVideo* AND soft-deletes the source row in one batch', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.upsertVideoPrimary({
      sequenceId,
      url: 'https://example.com/old.mp4',
      storagePath: '/p/old.mp4',
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date('2026-04-01T00:00:00Z'),
      error: null,
      inputHash: 'old-hash',
    });
    const divergent = await methods.insertDivergentVideo({
      sequenceId,
      url: 'https://example.com/new.mp4',
      storagePath: '/p/new.mp4',
      workflow: 'merge-video',
      status: 'completed',
      generatedAt: new Date('2026-04-29T00:00:00Z'),
      error: null,
      inputHash: 'new-hash',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const { discardedAt } = await methods.promoteVideoVariant(divergent.id);

    const rows = await db.select().from(sequences);
    const updated = rows.find((s) => s.id === sequenceId);
    expect(updated).toBeDefined();
    expect(updated?.mergedVideoUrl).toBe('https://example.com/new.mp4');
    expect(updated?.mergedVideoPath).toBe('/p/new.mp4');
    expect(updated?.mergedVideoStatus).toBe('completed');

    // Atomic-promote leg: the source variant must disappear from the divergent
    // list. Without this assertion, a regression dropping the second batch
    // statement would leave the alternate visible forever. SQLite stores
    // timestamps at second resolution, so compare floored seconds.
    const variantRow = await methods.getVideoById(divergent.id);
    expect(variantRow?.discardedAt).not.toBeNull();
    expect(Math.floor((variantRow?.discardedAt?.getTime() ?? 0) / 1000)).toBe(
      Math.floor(discardedAt.getTime() / 1000)
    );
    const stillDivergent = await methods.listDivergentVideos(sequenceId);
    expect(stillDivergent).toHaveLength(0);
  });

  it('promoteVideoVariant throws when the variant id does not exist', async () => {
    const methods = createSequenceVariantsMethods(db);
    let error: Error | null = null;
    try {
      await methods.promoteVideoVariant(generateId());
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/not found/);
  });
});

describe('createSequenceVariantsMethods — music', () => {
  it('writeMusicVariant forks to divergent on hash mismatch', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.writeMusicVariant({
      sequenceId,
      url: 'https://example.com/m1.mp3',
      storagePath: null,
      prompt: 'p',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'm-hash-1',
    });
    const second = await methods.writeMusicVariant({
      sequenceId,
      url: 'https://example.com/m2.mp3',
      storagePath: null,
      prompt: 'p2',
      tags: 't2',
      durationSeconds: 90,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'm-hash-2',
    });
    expect(second.divergent).toBe(true);

    const primary = await methods.getMusicPrimary(sequenceId, 'cassette');
    expect(primary?.url).toBe('https://example.com/m1.mp3');
  });

  it('promoteMusicVariant copies prompt/tags/url onto sequences.music* AND soft-deletes the source row in one batch', async () => {
    const methods = createSequenceVariantsMethods(db);
    // Seed a divergent alternate via the divergence-routing path so the
    // variant has divergedAt set — then promote it.
    await methods.upsertMusicPrimary({
      sequenceId,
      url: 'https://example.com/old.mp3',
      storagePath: null,
      prompt: 'old',
      tags: 'old',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date('2026-04-01T00:00:00Z'),
      error: null,
      inputHash: 'old-hash',
    });
    const divergent = await methods.insertDivergentMusic({
      sequenceId,
      url: 'https://example.com/m.mp3',
      storagePath: '/p/m.mp3',
      prompt: 'jazzy',
      tags: 'lofi',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date('2026-04-29T00:00:00Z'),
      error: null,
      inputHash: 'new-hash',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const { discardedAt } = await methods.promoteMusicVariant(divergent.id);

    const rows = await db.select().from(sequences);
    const updated = rows.find((s) => s.id === sequenceId);
    expect(updated).toBeDefined();
    expect(updated?.musicUrl).toBe('https://example.com/m.mp3');
    expect(updated?.musicPrompt).toBe('jazzy');
    expect(updated?.musicModel).toBe('cassette');
    expect(updated?.musicStatus).toBe('completed');

    // Atomic-promote leg: source row must be soft-deleted in the same batch.
    // SQLite stores timestamps at second resolution.
    const variantRow = await methods.getMusicById(divergent.id);
    expect(variantRow?.discardedAt).not.toBeNull();
    expect(Math.floor((variantRow?.discardedAt?.getTime() ?? 0) / 1000)).toBe(
      Math.floor(discardedAt.getTime() / 1000)
    );
    const stillDivergent = await methods.listDivergentMusic(sequenceId);
    expect(stillDivergent).toHaveLength(0);
  });

  it('promoteMusicVariant throws when the variant id does not exist', async () => {
    const methods = createSequenceVariantsMethods(db);
    let error: Error | null = null;
    try {
      await methods.promoteMusicVariant(generateId());
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/not found/);
  });

  it('insertDivergentMusic idempotent on retry', async () => {
    const methods = createSequenceVariantsMethods(db);
    await methods.upsertMusicPrimary({
      sequenceId,
      url: 'https://example.com/p.mp3',
      storagePath: null,
      prompt: 'p',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'p-hash',
    });
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    const first = await methods.insertDivergentMusic({
      sequenceId,
      url: 'https://example.com/d.mp3',
      storagePath: null,
      prompt: 'd',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'd-hash',
      divergedAt,
    });
    const second = await methods.insertDivergentMusic({
      sequenceId,
      url: 'https://example.com/d.mp3',
      storagePath: null,
      prompt: 'd',
      tags: 't',
      durationSeconds: 60,
      model: 'cassette',
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: 'd-hash',
      divergedAt,
    });
    expect(second.id).toBe(first.id);
  });
});

describe('listDivergentByTeam', () => {
  it('excludes variants belonging to a different team, excludes discarded rows, and merges video+music flags per sequence', async () => {
    const methods = createSequenceVariantsMethods(db);

    // Build a second team with its own sequence sharing the same style.
    const otherTeamId = generateId();
    await db.insert(teams).values({
      id: otherTeamId,
      name: 'Other',
      slug: 'other',
    });
    const [otherStyle] = await db
      .insert(styles)
      .values({
        teamId: otherTeamId,
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
    const otherSequenceId = generateId();
    await db.insert(sequences).values({
      id: otherSequenceId,
      teamId: otherTeamId,
      title: 'Other',
      styleId: otherStyle.id,
    });

    // Add a second sequence on the seed team so we can test the
    // "video+music on the same sequence merge into one row" axis as well as
    // the "two sequences => two rows" axis.
    const secondSeedSequenceId = generateId();
    const [seedStyle] = await db
      .select()
      .from(styles)
      .where(eq(styles.teamId, team.id));
    await db.insert(sequences).values({
      id: secondSeedSequenceId,
      teamId: team.id,
      title: 'S2',
      styleId: seedStyle.id,
    });

    const divergedAt = new Date('2026-04-29T00:00:00Z');

    // Live divergent video on seed team's primary sequence.
    await db.insert(sequenceVideoVariants).values({
      sequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/v-divergent.mp4',
      status: 'completed',
      inputHash: 'v-hash',
      divergedAt,
    });

    // Live divergent music ALSO on the same primary sequence (should collapse
    // with the video row to a single { hasVideo: true, hasMusic: true } entry).
    await db.insert(sequenceMusicVariants).values({
      sequenceId,
      model: 'cassette',
      url: 'https://example.com/m-divergent.mp3',
      status: 'completed',
      inputHash: 'm-hash',
      divergedAt,
    });

    // Live divergent music on the second seed-team sequence (separate row).
    await db.insert(sequenceMusicVariants).values({
      sequenceId: secondSeedSequenceId,
      model: 'cassette',
      url: 'https://example.com/m2-divergent.mp3',
      status: 'completed',
      inputHash: 'm2-hash',
      divergedAt,
    });

    // Discarded divergent video on the seed team — must be excluded.
    await db.insert(sequenceVideoVariants).values({
      sequenceId: secondSeedSequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/v-discarded.mp4',
      status: 'completed',
      inputHash: 'discarded-hash',
      divergedAt,
      discardedAt: new Date('2026-04-30T00:00:00Z'),
    });

    // Live divergent video on the OTHER team — must be excluded by team scope.
    await db.insert(sequenceVideoVariants).values({
      sequenceId: otherSequenceId,
      workflow: 'merge-video',
      url: 'https://example.com/other.mp4',
      status: 'completed',
      inputHash: 'other-hash',
      divergedAt,
    });

    const rows = await methods.listDivergentByTeam(team.id);
    const byId = new Map(rows.map((r) => [r.sequenceId, r]));

    expect(rows).toHaveLength(2);
    expect(byId.get(sequenceId)).toEqual({
      sequenceId,
      hasVideo: true,
      hasMusic: true,
    });
    expect(byId.get(secondSeedSequenceId)).toEqual({
      sequenceId: secondSeedSequenceId,
      hasVideo: false,
      hasMusic: true,
    });
    // Other team's sequence must not appear.
    expect(byId.has(otherSequenceId)).toBe(false);
  });
});
