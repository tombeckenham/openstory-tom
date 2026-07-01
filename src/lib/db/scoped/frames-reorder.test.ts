/**
 * Integration test for `frames.reorder()` against a real in-memory SQLite with
 * the production migrations applied — so the unique `(sequenceId, orderIndex)`
 * index is enforced exactly as it is in D1.
 *
 * This is the regression guard for the collision trap: reassigning order
 * indices in a single batch transaction would violate the unique index the
 * moment a frame moves into a slot another row still holds. The two-phase
 * (park-at-negative, then assign) write must avoid that.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { frames, sequences, styles, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFramesMethods } from './frames';

let client: Client;
let db: Database;
let sequenceId = '';

const scene = (sceneNumber: number): Scene => ({
  sceneId: `scene-${sceneNumber}`,
  sceneNumber,
  originalScript: { extract: '', dialogue: [] },
});

async function seed() {
  await db.delete(frames);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  const teamId = generateId();
  const userId = generateId();
  sequenceId = generateId();

  await db.insert(user).values([{ id: userId, name: 'U', email: 'u@e.com' }]);
  await db.insert(teams).values([{ id: teamId, name: 'T', slug: 't' }]);
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
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db
    .insert(sequences)
    .values([{ id: sequenceId, teamId, title: 'S', styleId: style.id }]);

  // Three frames in their original 0,1,2 order with matching scene numbers.
  await db.insert(frames).values([
    { id: 'fa', sequenceId, orderIndex: 0, metadata: scene(1) },
    { id: 'fb', sequenceId, orderIndex: 1, metadata: scene(2) },
    { id: 'fc', sequenceId, orderIndex: 2, metadata: scene(3) },
  ]);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('frames.reorder', () => {
  it('reorders without violating the unique (sequenceId, orderIndex) index', async () => {
    const methods = createFramesMethods(db);

    // Move fc to the front: [c, a, b]. Naively assigning fc.orderIndex=0 while
    // fa still holds 0 would throw a UNIQUE violation mid-batch.
    await methods.reorder(sequenceId, [
      { id: 'fc', order_index: 0 },
      { id: 'fa', order_index: 1 },
      { id: 'fb', order_index: 2 },
    ]);

    const ordered = await methods.listBySequence(sequenceId);
    expect(ordered.map((f) => f.id)).toEqual(['fc', 'fa', 'fb']);
    expect(ordered.map((f) => f.orderIndex)).toEqual([0, 1, 2]);
  });

  it('applies the renumbered metadata.sceneNumber passed by the caller', async () => {
    const methods = createFramesMethods(db);

    await methods.reorder(sequenceId, [
      { id: 'fc', order_index: 0, metadata: scene(1) },
      { id: 'fa', order_index: 1, metadata: scene(2) },
      { id: 'fb', order_index: 2, metadata: scene(3) },
    ]);

    const ordered = await methods.listBySequence(sequenceId);
    expect(ordered.map((f) => f.metadata?.sceneNumber)).toEqual([1, 2, 3]);
    // The frame that moved to the top (fc) now carries sceneNumber 1.
    expect(ordered[0]?.id).toBe('fc');
    expect(ordered[0]?.metadata?.sceneNumber).toBe(1);
  });

  it('handles a full reversal', async () => {
    const methods = createFramesMethods(db);

    await methods.reorder(sequenceId, [
      { id: 'fc', order_index: 0 },
      { id: 'fb', order_index: 1 },
      { id: 'fa', order_index: 2 },
    ]);

    const ordered = await methods.listBySequence(sequenceId);
    expect(ordered.map((f) => f.id)).toEqual(['fc', 'fb', 'fa']);
  });
});
