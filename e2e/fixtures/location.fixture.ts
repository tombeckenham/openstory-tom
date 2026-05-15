/**
 * Location Fixture for E2E Tests
 * Creates test library locations for testing location library flows
 */

import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { testDb } from './db-client';
import { locationLibrary } from '@/lib/db/schema';

export type TestLibraryLocation = {
  id: string;
  name: string;
  teamId: string;
  referenceImageUrl: string;
};

/**
 * Create test library location with reference image
 */
export async function createTestLibraryLocation(
  teamId: string,
  name: string
): Promise<TestLibraryLocation> {
  const locationId = ulid();
  const now = new Date();
  const referenceImageUrl = `http://localhost:3001/api/test/image?w=1024&h=576&label=location`;

  await testDb.insert(locationLibrary).values({
    id: locationId,
    teamId,
    name,
    description: 'A test location for e2e testing',
    referenceImageUrl,
    createdAt: now,
    updatedAt: now,
  });

  return { id: locationId, name, teamId, referenceImageUrl };
}

/**
 * Create multiple test library locations for a team
 */
export async function createTestLibraryLocationSet(
  teamId: string,
  names: string[]
): Promise<TestLibraryLocation[]> {
  const locations: TestLibraryLocation[] = [];
  for (const name of names) {
    const location = await createTestLibraryLocation(teamId, name);
    locations.push(location);
  }
  return locations;
}

/**
 * Clean up test library locations by team ID (use only when test isolation isn't needed)
 */
export async function cleanupTestLocations(teamId: string): Promise<void> {
  await testDb
    .delete(locationLibrary)
    .where(eq(locationLibrary.teamId, teamId));
}

/**
 * Clean up a specific location by ID (use for parallel test isolation)
 */
export async function cleanupLocationById(locationId: string): Promise<void> {
  await testDb
    .delete(locationLibrary)
    .where(eq(locationLibrary.id, locationId));
}

/**
 * Look up a seeded system location by name. System locations are inserted by
 * `scripts/seed.ts --test` during global setup; they have real R2 reference
 * images so workflows can use them for location matching and sheet rendering.
 * Tests should prefer these over fabricated locations with placeholder URLs.
 */
export async function getSystemLocationByName(
  name: string
): Promise<TestLibraryLocation> {
  const rows = await testDb
    .select()
    .from(locationLibrary)
    .where(
      and(eq(locationLibrary.name, name), eq(locationLibrary.isPublic, true))
    )
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      `System location "${name}" not found in test DB — was \`bun scripts/seed.ts --test\` run during global setup?`
    );
  }
  const found = rows[0];
  if (!found) {
    throw new Error('test setup: expected location row');
  }
  return {
    id: found.id,
    name: found.name,
    teamId: found.teamId,
    referenceImageUrl: found.referenceImageUrl ?? '',
  };
}
