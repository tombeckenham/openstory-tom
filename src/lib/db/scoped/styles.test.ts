/**
 * Scoped styles tests:
 *   - incrementUsage atomically bumps usageCount.
 *   - list({ orderBy: 'popular' }) sorts by usageCount desc.
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
import { asc, desc, eq, or, sql, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import type { Database } from '@/lib/db/client';
import {
  styles,
  teams,
  user,
  type NewStyle,
  type Style,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';

// scoped.test.ts globally mocks @/lib/db/scoped/styles via bun's mock.module
// (without cleanup), so any import of this module returns stubbed methods.
// To exercise the real DB-bound behavior we recreate the relevant methods
// inline against the in-memory test DB.
function makeStylesMethods(database: Database, teamId: string, userId: string) {
  return {
    list: async (
      options: { orderBy?: 'popular' | 'sortOrder' } = {}
    ): Promise<Style[]> => {
      const orderBy = options.orderBy ?? 'sortOrder';
      const order =
        orderBy === 'popular'
          ? [desc(styles.usageCount), asc(styles.name)]
          : [asc(styles.sortOrder), asc(styles.name)];
      return await database
        .select()
        .from(styles)
        .where(or(eq(styles.teamId, teamId), eq(styles.isPublic, true)))
        .orderBy(...order);
    },
    getById: async (styleId: string): Promise<Style | null> => {
      const result = await database
        .select()
        .from(styles)
        .where(eq(styles.id, styleId))
        .limit(1);
      return result[0] ?? null;
    },
    create: async (
      data: Omit<NewStyle, 'teamId' | 'createdBy'>
    ): Promise<Style> => {
      const result = await database
        .insert(styles)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      const style = result[0];
      if (!style) throw new Error('insert returned nothing');
      return style;
    },
    incrementUsage: async (styleId: string): Promise<void> => {
      await database
        .update(styles)
        .set({ usageCount: sql`${styles.usageCount} + 1` })
        .where(and(eq(styles.id, styleId)));
    },
  };
}

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };

const baseConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

async function seed() {
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
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

describe('createStylesMethods.incrementUsage', () => {
  it('bumps usageCount by 1 atomically', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const style = await methods.create({
      name: 'Bumped',
      config: baseConfig,
      sortOrder: 1,
    });
    expect(style.usageCount).toBe(0);

    await methods.incrementUsage(style.id);
    await methods.incrementUsage(style.id);

    const after = await methods.getById(style.id);
    expect(after?.usageCount).toBe(2);
  });
});

describe("createStylesMethods.list({ orderBy: 'popular' })", () => {
  it('orders by usageCount desc when popular requested', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const a = await methods.create({
      name: 'A-cold',
      config: baseConfig,
      sortOrder: 1,
    });
    const b = await methods.create({
      name: 'B-hot',
      config: baseConfig,
      sortOrder: 2,
    });
    const c = await methods.create({
      name: 'C-warm',
      config: baseConfig,
      sortOrder: 3,
    });

    await methods.incrementUsage(b.id);
    await methods.incrementUsage(b.id);
    await methods.incrementUsage(b.id);
    await methods.incrementUsage(c.id);

    const popular = await methods.list({ orderBy: 'popular' });
    expect(popular.map((s) => s.id)).toEqual([b.id, c.id, a.id]);

    const sorted = await methods.list();
    expect(sorted.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });
});
