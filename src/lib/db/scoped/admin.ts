/**
 * Scoped Admin Sub-module
 * Admin-only operations: gift token creation, listing, and redemption.
 * Not team-scoped (admin operations span all teams).
 */

import { micros, microsToUsd, usdToMicros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { frames, sequences, user } from '@/lib/db/schema';
import type { Frame, Sequence } from '@/lib/db/schema';
import { giftTokenRedemptions, giftTokens } from '@/lib/db/schema/gift-tokens';
import type { GiftToken } from '@/lib/db/schema/gift-tokens';
import { ValidationError } from '@/lib/errors';
import { asc, count, desc, eq, not, sql } from 'drizzle-orm';

// Ambiguity-free alphabet (no 0/O/1/I) -- 32 chars -> 32^6 ~ 1B combinations
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateGiftCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join('');
}

export type GiftTokenStatus = 'available' | 'fully_redeemed' | 'expired';

export function getGiftTokenStatus(
  token: GiftToken,
  redemptionCount: number
): GiftTokenStatus {
  if (redemptionCount >= token.maxRedemptions) return 'fully_redeemed';
  if (token.expiresAt && token.expiresAt < new Date()) return 'expired';
  return 'available';
}

export type GiftTokenWithStatus = GiftToken & {
  status: GiftTokenStatus;
  amountUsd: number;
  redemptionCount: number;
};

export function createAdminMethods(db: Database) {
  async function createGiftToken(opts: {
    createdByUserId: string;
    amountUsd: number;
    maxRedemptions?: number;
    note?: string;
    expiresAt?: Date;
  }): Promise<GiftToken> {
    if (opts.amountUsd <= 0) {
      throw new ValidationError('Gift token amount must be positive');
    }

    const maxRedemptions = opts.maxRedemptions ?? 1;
    if (maxRedemptions < 1) {
      throw new ValidationError('Max redemptions must be at least 1');
    }

    const code = generateGiftCode();
    const amountMicros = usdToMicros(opts.amountUsd);

    const [token] = await db
      .insert(giftTokens)
      .values({
        id: generateId(),
        code,
        amountMicros,
        maxRedemptions,
        createdByUserId: opts.createdByUserId,
        note: opts.note ?? null,
        expiresAt: opts.expiresAt ?? null,
      })
      .returning();

    return token;
  }

  async function listGiftTokens(): Promise<GiftTokenWithStatus[]> {
    const redemptionCountSq = db
      .select({
        giftTokenId: giftTokenRedemptions.giftTokenId,
        count: count().as('count'),
      })
      .from(giftTokenRedemptions)
      .groupBy(giftTokenRedemptions.giftTokenId)
      .as('redemption_counts');

    const tokens = await db
      .select({
        token: giftTokens,
        redemptionCount: sql<number>`coalesce(${redemptionCountSq.count}, 0)`,
      })
      .from(giftTokens)
      .leftJoin(
        redemptionCountSq,
        eq(giftTokens.id, redemptionCountSq.giftTokenId)
      )
      .orderBy(desc(giftTokens.createdAt));

    return tokens.map(({ token, redemptionCount }) => ({
      ...token,
      redemptionCount,
      status: getGiftTokenStatus(token, redemptionCount),
      amountUsd: microsToUsd(micros(token.amountMicros)),
    }));
  }

  // ---- Support: cross-team sequence/frame access ----

  type SequenceWithCreator = Sequence & { creatorName: string | null };

  async function getAllSequences(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<SequenceWithCreator[]> {
    const { limit = 50, offset = 0 } = opts ?? {};

    const rows = await db
      .select({
        sequence: sequences,
        creatorName: user.name,
      })
      .from(sequences)
      .leftJoin(user, eq(sequences.createdBy, user.id))
      .where(not(eq(sequences.status, 'archived')))
      .orderBy(desc(sequences.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map(({ sequence, creatorName }) => ({
      ...sequence,
      creatorName,
    }));
  }

  async function getFramesForSequence(sequenceId: string): Promise<Frame[]> {
    return await db
      .select()
      .from(frames)
      .where(eq(frames.sequenceId, sequenceId))
      .orderBy(asc(frames.orderIndex));
  }

  return {
    createGiftToken,
    listGiftTokens,
    getAllSequences,
    getFramesForSequence,
  };
}
