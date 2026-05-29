/**
 * Test-only data seeding helpers.
 *
 * These run INSIDE the Worker (via the guarded /api/test/* routes),
 * so all DB writes go through the single safe Miniflare instance
 * started by @cloudflare/vite-plugin during E2E tests.
 *
 * Do NOT import this from e2e/ fixtures directly — call the HTTP endpoints instead.
 */

import { generateId } from '@/lib/db/id';
import {
  credits,
  frames,
  locationLibrary,
  locationSheets,
  sequences,
  session,
  styles,
  talent,
  talentSheets,
  teamMembers,
  teams,
  user,
  verification,
} from '@/lib/db/schema';
import { getDb } from '#db-client';
import { eq } from 'drizzle-orm';

export type CreatedTestUser = {
  id: string;
  email: string;
  name: string;
  teamId: string;
};

export type CreatedTestStyle = {
  id: string;
  teamId: string;
};

export type CreatedTestSequence = {
  id: string;
  teamId: string;
  styleId: string;
  title: string;
};

export type CreatedTestFrame = {
  id: string;
  sequenceId: string;
  orderIndex: number;
};

export type CreatedTestTalent = {
  id: string;
  teamId: string;
  name: string;
  defaultSheetId: string;
};

/**
 * Create a test user + team + membership + credits.
 * Mirrors the previous direct logic from e2e/fixtures/auth.fixture.ts
 */
export async function createTestUser(
  opts: { name?: string } = {}
): Promise<CreatedTestUser> {
  const db = getDb();
  const now = new Date();

  const userId = generateId();
  const teamId = generateId();
  const name = opts.name ?? 'E2E Test User';

  const email = `test-${userId.slice(-8).toLowerCase()}@e2e.test`;
  const teamSlug = `test-team-${teamId.slice(-8).toLowerCase()}`;

  await db.insert(user).values({
    id: userId,
    name,
    email,
    emailVerified: true,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(teams).values({
    id: teamId,
    name: 'E2E Test Team',
    slug: teamSlug,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(teamMembers).values({
    teamId,
    userId,
    role: 'owner',
    joinedAt: now,
  });

  await db.insert(credits).values({
    teamId,
    balance: 100_000_000, // generous for tests
    updatedAt: now,
  });

  return { id: userId, email, name, teamId };
}

/**
 * Create a verification record (OTP) for a test user.
 */
export async function createOtpVerification(
  email: string,
  otp: string
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

  // Delete any existing verification for this email first (mirrors old logic)
  await db.delete(verification).where(eq(verification.identifier, email));

  await db.insert(verification).values({
    id: generateId(),
    identifier: email,
    value: otp,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Clean up a test user and related records.
 */
export async function cleanupTestUser(
  userId: string,
  teamId: string
): Promise<void> {
  const db = getDb();

  await db.delete(session).where(eq(session.userId, userId));
  await db.delete(teamMembers).where(eq(teamMembers.userId, userId));
  await db.delete(teams).where(eq(teams.id, teamId));
  await db.delete(user).where(eq(user.id, userId));
  // Credits will cascade or be cleaned via team if we add FKs later
}

/**
 * Create a minimal test style for a team.
 */
export async function createTestStyle(
  teamId: string
): Promise<CreatedTestStyle> {
  const db = getDb();
  const now = new Date();
  const styleId = generateId();

  const styleConfig = {
    artStyle: 'Cinematic',
    colorPalette: ['#000000', '#FFFFFF'],
    lighting: 'Natural',
    cameraWork: 'Standard',
    mood: 'Dramatic',
    referenceFilms: ['Test Film'],
    colorGrading: 'Natural',
  };

  await db.insert(styles).values({
    id: styleId,
    teamId,
    name: 'E2E Test Style',
    config: styleConfig,
    createdAt: now,
    updatedAt: now,
  });

  return { id: styleId, teamId };
}

/**
 * Create a basic completed test sequence (no frames).
 */
export async function createTestSequence(
  teamId: string,
  userId: string,
  title = 'E2E Test Sequence'
): Promise<CreatedTestSequence> {
  const db = getDb();
  const now = new Date();
  const sequenceId = generateId();
  const style = await createTestStyle(teamId);

  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title,
    status: 'completed',
    styleId: style.id,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  return { id: sequenceId, teamId, styleId: style.id, title };
}

/**
 * Create a single frame for a sequence (useful for variant tests).
 */
export async function createTestFrame(
  sequenceId: string,
  orderIndex: number,
  options: {
    thumbnailUrl?: string;
    variantImageUrl?: string | null;
    variantImageStatus?: 'pending' | 'generating' | 'completed' | 'failed';
  } = {}
): Promise<CreatedTestFrame> {
  const db = getDb();
  const now = new Date();
  const frameId = generateId();

  const {
    thumbnailUrl = `http://localhost:3001/api/test/image?w=1024&h=576&label=thumb`,
    variantImageUrl = null,
    variantImageStatus = 'pending',
  } = options;

  await db.insert(frames).values({
    id: frameId,
    sequenceId,
    orderIndex,
    thumbnailUrl,
    thumbnailStatus: 'completed',
    variantImageUrl,
    variantImageStatus,
    createdAt: now,
    updatedAt: now,
  });

  return { id: frameId, sequenceId, orderIndex };
}

/**
 * Create test talent + default sheet.
 */
export async function createTestTalent(
  teamId: string,
  name: string
): Promise<CreatedTestTalent> {
  const db = getDb();
  const now = new Date();
  const talentId = generateId();
  const sheetId = generateId();

  await db.insert(talent).values({
    id: talentId,
    teamId,
    name,
    isInTeamLibrary: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(talentSheets).values({
    id: sheetId,
    talentId,
    name: 'Default',
    imageUrl: `http://localhost:3001/api/test/image?w=512&h=512&label=sheet`,
    imagePath: `talent/${name.toLowerCase().replace(/\s+/g, '-')}/sheet.webp`,
    isDefault: true,
    source: 'manual_upload',
    createdAt: now,
    updatedAt: now,
  });

  return { id: talentId, teamId, name, defaultSheetId: sheetId };
}

/**
 * Create a test location + default sheet.
 */
export async function createTestLocation(
  teamId: string,
  name: string
): Promise<{ id: string; teamId: string; name: string }> {
  const db = getDb();
  const now = new Date();

  const [inserted] = await db
    .insert(locationLibrary)
    .values({
      teamId,
      name,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: locationLibrary.id });

  if (!inserted) {
    throw new Error('Failed to create test location');
  }

  const sheetId = generateId();
  await db.insert(locationSheets).values({
    id: sheetId,
    locationId: inserted.id,
    name: 'Default',
    imageUrl: `http://localhost:3001/api/test/image?w=1024&h=576&label=location`,
    imagePath: `locations/${name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')}/sheet.webp`,
    isDefault: true,
    source: 'ai_generated',
    createdAt: now,
    updatedAt: now,
  });

  return { id: inserted.id, teamId, name };
}

/**
 * Basic cleanup for a team's test data.
 * Prefer specific cleanups when possible.
 */
export async function cleanupTeamTestData(teamId: string): Promise<void> {
  const db = getDb();

  // Best-effort broad cleanup. Prefer the specific cleanup* functions in practice.
  await db.delete(sequences).where(eq(sequences.teamId, teamId));
  await db.delete(styles).where(eq(styles.teamId, teamId));
  await db.delete(talent).where(eq(talent.teamId, teamId));
  await db.delete(locationLibrary).where(eq(locationLibrary.teamId, teamId));
}
