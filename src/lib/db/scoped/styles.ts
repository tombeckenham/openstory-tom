/**
 * Scoped Styles Sub-module
 * Team-scoped style library CRUD (includes public styles in listing).
 */

import { asc, and, eq, or } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import { styles } from '@/lib/db/schema';
import type { NewStyle, Style } from '@/lib/db/schema';

export function createStylesReadMethods(db: Database, teamId: string) {
  return {
    list: async (): Promise<Style[]> => {
      return await db
        .select()
        .from(styles)
        .where(or(eq(styles.teamId, teamId), eq(styles.isPublic, true)))
        .orderBy(asc(styles.sortOrder), asc(styles.name));
    },

    getById: async (styleId: string): Promise<Style | null> => {
      const result = await db
        .select()
        .from(styles)
        .where(eq(styles.id, styleId))
        .limit(1);
      return result[0] ?? null;
    },

    getPublic: async (): Promise<Style[]> => {
      return await db
        .select()
        .from(styles)
        .where(eq(styles.isPublic, true))
        .orderBy(asc(styles.sortOrder), asc(styles.name));
    },
  };
}

export function createStylesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createStylesReadMethods(db, teamId),

    create: async (
      data: Omit<NewStyle, 'teamId' | 'createdBy'>
    ): Promise<Style> => {
      const result = await db
        .insert(styles)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      const style = result[0];
      if (!style) {
        throw new Error(`Failed to create Style for team ${teamId}`);
      }
      return style;
    },

    update: async (
      styleId: string,
      data: Partial<Omit<Style, 'id' | 'teamId' | 'createdAt' | 'createdBy'>>
    ): Promise<Style | undefined> => {
      const result = await db
        .update(styles)
        .set(data)
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)))
        .returning();
      return Array.isArray(result) ? result[0] : undefined;
    },

    delete: async (styleId: string): Promise<void> => {
      await db
        .delete(styles)
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)));
    },
  };
}
