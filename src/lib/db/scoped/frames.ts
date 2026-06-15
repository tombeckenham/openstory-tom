/**
 * Scoped Frames Sub-module
 * Frame CRUD, bulk operations, reorder, and reconciliation.
 */

import type { Database } from '@/lib/db/client';
import { frames } from '@/lib/db/schema';
import type { Frame, NewFrame } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

type FrameWithSequence = Frame & {
  sequence: Pick<
    Sequence,
    | 'id'
    | 'teamId'
    | 'title'
    | 'status'
    | 'styleId'
    | 'videoModel'
    | 'aspectRatio'
    | 'analysisModel'
  >;
};

type FrameOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

const FRAME_ARTIFACT_HASH_COLUMNS = {
  thumbnail: 'thumbnailInputHash',
  variantImage: 'variantImageInputHash',
  video: 'videoInputHash',
  audio: 'audioInputHash',
} as const satisfies Record<string, keyof Frame>;

export type FrameArtifact = keyof typeof FRAME_ARTIFACT_HASH_COLUMNS;

type FrameFilters = {
  orderBy?: FrameOrderBy;
  ascending?: boolean;
  limit?: number;
  offset?: number;
  hasThumbnail?: boolean;
  hasVideo?: boolean;
};

export function createFramesMethods(db: Database) {
  return {
    getById: async (frameId: string): Promise<Frame | null> => {
      const result = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frameId));
      return result[0] ?? null;
    },

    listBySequence: async (
      sequenceId: string,
      options?: FrameFilters
    ): Promise<Frame[]> => {
      const {
        orderBy = 'orderIndex',
        ascending = true,
        limit,
        offset,
        hasThumbnail,
        hasVideo,
      } = options ?? {};

      const conditions = [eq(frames.sequenceId, sequenceId)];

      if (hasThumbnail !== undefined && hasThumbnail) {
        conditions.push(isNull(frames.thumbnailUrl));
      }

      if (hasVideo !== undefined && hasVideo) {
        conditions.push(isNull(frames.videoUrl));
      }

      const orderColumn =
        orderBy === 'orderIndex'
          ? frames.orderIndex
          : orderBy === 'createdAt'
            ? frames.createdAt
            : frames.updatedAt;

      const orderFn = ascending ? asc : desc;

      let query = db
        .select()
        .from(frames)
        .where(and(...conditions))
        .orderBy(orderFn(orderColumn))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      if (offset) {
        query = query.offset(offset);
      }

      return await query;
    },

    create: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db.insert(frames).values(data).returning();
      if (!frame) {
        throw new Error(
          `Failed to create frame for sequence ${data.sequenceId}`
        );
      }
      return frame;
    },

    update: async (
      frameId: string,
      data: Partial<NewFrame>,
      options?: { throwOnMissing?: boolean }
    ): Promise<Frame | undefined> => {
      const [frame] = await db
        .update(frames)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frames.id, frameId))
        .returning();

      if (!frame && options?.throwOnMissing !== false) {
        throw new Error(`Frame ${frameId} not found`);
      }

      return frame;
    },
    upsert: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db
        .insert(frames)
        .values(data)
        .onConflictDoUpdate({
          target: [frames.sequenceId, frames.orderIndex],
          set: {
            description: sql.raw(`excluded."description"`),
            durationMs: sql.raw(`excluded."duration_ms"`),
            metadata: sql.raw(`excluded."metadata"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!frame) {
        throw new Error(
          `Failed to upsert frame for sequence ${data.sequenceId} at orderIndex ${data.orderIndex}`
        );
      }
      return frame;
    },
    delete: async (frameId: string): Promise<boolean> => {
      const result = await db.delete(frames).where(eq(frames.id, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frames)
        .where(eq(frames.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (frameData: NewFrame[]): Promise<Frame[]> => {
      const BATCH_SIZE = 5;
      const results: Frame[] = [];

      for (let i = 0; i < frameData.length; i += BATCH_SIZE) {
        const batch = frameData.slice(i, i + BATCH_SIZE);
        const batchResults = await db.insert(frames).values(batch).returning();
        results.push(...batchResults);
      }

      return results;
    },

    bulkUpsert: async (frameInserts: NewFrame[]): Promise<Frame[]> => {
      const BATCH_SIZE = 5;
      const results: Frame[] = [];

      for (let i = 0; i < frameInserts.length; i += BATCH_SIZE) {
        const batch = frameInserts.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(frames)
          .values(batch)
          .onConflictDoUpdate({
            target: [frames.sequenceId, frames.orderIndex],
            set: {
              description: sql.raw(`excluded."description"`),
              durationMs: sql.raw(`excluded."duration_ms"`),
              metadata: sql.raw(`excluded."metadata"`),
              updatedAt: new Date(),
            },
          })
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    reorder: async (
      _sequenceId: string,
      frameOrders: Array<{ id: string; order_index: number }>
    ): Promise<void> => {
      if (frameOrders.length === 0) return;
      // Two-phase update to avoid tripping the (sequence_id, order_index)
      // unique index. SQLite checks UNIQUE constraints immediately (per
      // statement), so updating a frame to an index another not-yet-moved
      // frame still holds — unavoidable in any non-trivial reorder — would
      // collide. Phase 1 parks every frame in a distinct negative slot (which
      // can't collide with the non-negative final values), phase 2 assigns the
      // real indices. Callers MUST pass the full set of frames for the
      // sequence so no row is left holding a final value during phase 2.
      const buildBatch = (
        updates: Array<{ id: string; orderIndex: number }>
      ) => {
        const [first, ...rest] = updates.map((u) =>
          db
            .update(frames)
            .set({ orderIndex: u.orderIndex, updatedAt: new Date() })
            .where(eq(frames.id, u.id))
        );
        return first ? ([first, ...rest] as const) : null;
      };

      const tempBatch = buildBatch(
        frameOrders.map((f, i) => ({ id: f.id, orderIndex: -(i + 1) }))
      );
      const finalBatch = buildBatch(
        frameOrders.map((f) => ({ id: f.id, orderIndex: f.order_index }))
      );
      if (!tempBatch || !finalBatch) return;
      await db.batch(tempBatch);
      await db.batch(finalBatch);
    },

    getByIds: async (frameIds: string[]): Promise<Frame[]> => {
      if (frameIds.length === 0) return [];
      return await db.select().from(frames).where(inArray(frames.id, frameIds));
    },

    /**
     * Compares the stored input hash for an artifact against a caller-provided
     * fresh hash. Returns false when the stored hash is null — legacy artifacts
     * predating hash tracking are treated as "unknown, not stale" rather than
     * forced into regeneration. Throws when the frame row does not exist.
     */
    isStale: async (
      frameId: string,
      artifact: FrameArtifact,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({
          hash: frames[FRAME_ARTIFACT_HASH_COLUMNS[artifact]],
        })
        .from(frames)
        .where(eq(frames.id, frameId));
      const row = result[0];
      if (!row) {
        throw new Error(`Frame ${frameId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    getWithSequence: async (
      frameId: string
    ): Promise<FrameWithSequence | null> => {
      const result = await db.query.frames.findFirst({
        where: { id: frameId },
        with: {
          sequence: {
            columns: {
              id: true,
              teamId: true,
              title: true,
              status: true,
              styleId: true,
              videoModel: true,
              aspectRatio: true,
              analysisModel: true,
            },
          },
        },
      });

      if (!result || !result.sequence) return null;
      return { ...result, sequence: result.sequence };
    },
  };
}
