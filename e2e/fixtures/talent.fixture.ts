/**
 * Talent Fixture for E2E Tests
 * Creates test talent with sheets for testing talent selection flows
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ulid } from 'ulid';
import { testDb } from './db-client';
import { talent, talentSheets, talentMedia } from '@/lib/db/schema';

export type TestTalent = {
  id: string;
  name: string;
  teamId: string;
  sheetId: string;
};

export type TestTalentWithMedia = TestTalent & {
  mediaIds: string[];
};

/**
 * Create test talent with a default sheet
 */
export async function createTestTalent(
  teamId: string,
  name: string
): Promise<TestTalent> {
  // Create via guarded test API (writes happen inside the single safe Miniflare)
  const res = await fetch('http://localhost:3001/api/test/talent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create test talent via API: ${res.status}`);
  }

  const created = z
    .object({
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      defaultSheetId: z.string(),
    })
    .parse(await res.json());

  return {
    id: created.id,
    name: created.name,
    teamId: created.teamId,
    sheetId: created.defaultSheetId,
  };
}

/**
 * Create multiple test talents for a team
 */
export async function createTestTalentSet(
  teamId: string,
  names: string[]
): Promise<TestTalent[]> {
  const talents: TestTalent[] = [];
  for (const name of names) {
    const talentRecord = await createTestTalent(teamId, name);
    talents.push(talentRecord);
  }
  return talents;
}

/**
 * Create test talent with reference media
 */
export async function createTestTalentWithMedia(
  teamId: string,
  name: string,
  mediaCount = 2
): Promise<TestTalentWithMedia> {
  const talentId = ulid();
  const sheetId = ulid();
  const now = new Date();

  // Insert talent
  await testDb.insert(talent).values({
    id: talentId,
    teamId,
    name,
    isInTeamLibrary: true,
    createdAt: now,
    updatedAt: now,
  });

  // Insert default sheet with local test image (no external dependencies)
  await testDb.insert(talentSheets).values({
    id: sheetId,
    talentId,
    name: 'Default',
    imageUrl: `http://localhost:3001/api/test/image?w=512&h=512&label=sheet`,
    isDefault: true,
    source: 'manual_upload',
    createdAt: now,
    updatedAt: now,
  });

  // Insert media records
  const mediaIds: string[] = [];
  for (let i = 0; i < mediaCount; i++) {
    const mediaId = ulid();
    mediaIds.push(mediaId);
    await testDb.insert(talentMedia).values({
      id: mediaId,
      talentId,
      type: 'image',
      url: `http://localhost:3001/api/test/image?w=400&h=400&label=media`,
      path: `${teamId}/${talentId}/${mediaId}.jpg`,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { id: talentId, name, teamId, sheetId, mediaIds };
}

/**
 * Clean up test talent by team ID (use only when test isolation isn't needed)
 */
export async function cleanupTestTalent(teamId: string): Promise<void> {
  // talent_sheets and talent_media will cascade delete from talent
  await testDb.delete(talent).where(eq(talent.teamId, teamId));
}

/**
 * Clean up a specific talent by ID (use for parallel test isolation)
 */
export async function cleanupTalentById(talentId: string): Promise<void> {
  await testDb.delete(talent).where(eq(talent.id, talentId));
}

/**
 * Look up a seeded system talent by name. System talents are inserted by
 * `scripts/seed.ts --test` during global setup; they have real R2 reference
 * images, so workflows can actually use them for character matching and
 * sheet rendering. Tests should use these instead of fabricating talent
 * with placeholder URLs.
 */
export async function getSystemTalentByName(name: string): Promise<TestTalent> {
  const rows = await testDb
    .select()
    .from(talent)
    .where(and(eq(talent.name, name), eq(talent.isPublic, true)))
    .limit(1);
  const found = rows[0];
  if (!found) {
    throw new Error(
      `System talent "${name}" not found in test DB — was \`bun scripts/seed.ts --test\` run during global setup?`
    );
  }
  const sheets = await testDb
    .select()
    .from(talentSheets)
    .where(
      and(eq(talentSheets.talentId, found.id), eq(talentSheets.isDefault, true))
    )
    .limit(1);
  const defaultSheet = sheets[0];
  if (!defaultSheet) {
    throw new Error(
      `System talent "${name}" has no default sheet — re-run seed`
    );
  }
  return {
    id: found.id,
    name: found.name,
    teamId: found.teamId,
    sheetId: defaultSheet.id,
  };
}
