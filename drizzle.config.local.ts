import { defineConfig } from 'drizzle-kit';

/**
 * Local development Drizzle configuration
 * Uses local SQLite file instead of Turso for faster development
 */
export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:local.db',
  },
  verbose: true,
  strict: true,
});
