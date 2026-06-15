/**
 * Reorder must survive the `(sequence_id, order_index)` unique index.
 *
 * SQLite checks UNIQUE constraints immediately (per statement), so any reorder
 * that moves a frame onto an index another not-yet-moved frame still holds
 * would collide if done as a naive single-pass batch. `reorder()` parks every
 * frame in a distinct negative slot first, then assigns the final indices —
 * these tests exercise the cases (swap, full reverse) that a single-pass batch
 * could not.
 */

import { type Client, createClient } from '@libsql/client';
import { generateId } from '@/lib/db/id';
import { frames, sequences, styles, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFramesMethods } from './frames';

let client: Client;
let db: Database;
let methods: ReturnType<typeof createFramesMethods>;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';
let frameIds: string[] = [];

async function seed() {
  await db.delete(frames);
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
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db
    .insert(sequences)
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
    ]);

  // Four frames at indices 0..3.
  frameIds = [];
  for (let i = 0; i < 4; i++) {
    const [frame] = await db
      .insert(frames)
      .values({ sequenceId, orderIndex: i })
      .returning();
    if (!frame) throw new Error('test setup: frame insert returned nothing');
    frameIds.push(frame.id);
  }
}

async function currentOrder(): Promise<string[]> {
  const rows = await db
    .select()
    .from(frames)
    .where(eq(frames.sequenceId, sequenceId));
  return rows.sort((a, b) => a.orderIndex - b.orderIndex).map((r) => r.id);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  methods = createFramesMethods(db);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('frames.reorder', () => {
  it('swaps two adjacent frames without tripping the unique index', async () => {
    // Swap indices 0 and 1 — the case a naive single-pass batch collides on.
    const [f0, f1, f2, f3] = frameIds;
    if (!f0 || !f1 || !f2 || !f3) throw new Error('expected 4 seeded frames');
    const next = [f1, f0, f2, f3];
    await methods.reorder(
      sequenceId,
      next.map((id, index) => ({ id, order_index: index }))
    );
    expect(await currentOrder()).toEqual(next);
  });

  it('fully reverses the order', async () => {
    const next = [...frameIds].reverse();
    await methods.reorder(
      sequenceId,
      next.map((id, index) => ({ id, order_index: index }))
    );
    expect(await currentOrder()).toEqual(next);
  });

  it('moves the first frame to the end (rotation)', async () => {
    const next = [...frameIds.slice(1), ...frameIds.slice(0, 1)];
    await methods.reorder(
      sequenceId,
      next.map((id, index) => ({ id, order_index: index }))
    );
    expect(await currentOrder()).toEqual(next);
  });

  it('is a no-op for an empty order list', async () => {
    await methods.reorder(sequenceId, []);
    expect(await currentOrder()).toEqual(frameIds);
  });
});
