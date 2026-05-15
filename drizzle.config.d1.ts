import { defineConfig } from 'drizzle-kit';

/**
 * Cloudflare D1 Drizzle configuration
 *
 * D1-specific commands:
 *   bun db:migrate:d1   # Apply migrations to remote D1 via HTTP API
 *   bun db:push:d1      # Push schema directly to remote D1
 *   bun db:studio:d1    # Open Drizzle Studio connected to D1
 *
 * Requires env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN
 */
export default defineConfig({
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? '',
    token: process.env.CLOUDFLARE_API_TOKEN ?? '',
  },
  verbose: true,
  strict: true,
});
