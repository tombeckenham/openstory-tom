---
title: Deploy to Cloudflare
description: Deploy OpenStory to Cloudflare Workers with D1 and R2
section: Developer Guide
order: 10
---

OpenStory deploys to Cloudflare Workers, using D1 (SQLite) for the database and R2 for media storage.

## Prerequisites

- A [Cloudflare](https://cloudflare.com) account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency — use `bunx wrangler`)
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` available in your environment

## wrangler.jsonc

Bindings live in [`wrangler.jsonc`](https://github.com/anthropics/openstory/blob/main/wrangler.jsonc) at the repo root:

- `DB` — D1 database (`openstory-prd`)
- `R2_PUBLIC_ASSETS_BUCKET` — public assets (served via custom domain)
- `R2_STORAGE_BUCKET` — private storage for generated media

The Worker entry point is `src/server.ts` with `nodejs_compat` enabled.

## Build & Deploy

```bash
# Generate Worker types from wrangler.jsonc
bun cf:typegen

# Build for Cloudflare (sets BUILD_CLOUDFLARE=1 so Vite uses the Cloudflare preset)
bun cf:build

# Deploy to production (runs cf:build then `wrangler deploy`)
bun cf:deploy:prd
```

## Database Migrations

D1 migrations use a separate Drizzle config:

```bash
bun --bun drizzle-kit migrate --config=drizzle.config.d1.ts
bun db:seed:d1
```

CI runs both before each deploy.

## Secrets

Secrets are pushed to the Worker via `wrangler secret bulk`. The full list is defined in [`.github/workflows/deploy-cloudflare.yml`](https://github.com/anthropics/openstory/blob/main/.github/workflows/deploy-cloudflare.yml). Core secrets include:

| Variable                                    | Description                               |
| ------------------------------------------- | ----------------------------------------- |
| `BETTER_AUTH_SECRET`                        | Better Auth signing secret                |
| `VITE_APP_URL`                              | Public URL of the deployment              |
| `FAL_KEY`                                   | fal.ai API key for image/video generation |
| `QSTASH_TOKEN`                              | QStash token for workflow execution       |
| `QSTASH_CURRENT_SIGNING_KEY`                | QStash request verification               |
| `QSTASH_NEXT_SIGNING_KEY`                   | QStash request verification (rotation)    |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials                  |
| `RESEND_API_KEY`                            | Transactional email                       |

## CI/CD

[`deploy-cloudflare.yml`](https://github.com/anthropics/openstory/blob/main/.github/workflows/deploy-cloudflare.yml) handles:

- **Production**: pushes to `main` migrate D1, seed, then `bun cf:deploy:prd`.
- **PR previews**: each PR gets its own Worker (`pr-<number>`) and D1 database (`openstory-pr-<number>`), with secrets pushed and the preview URL posted as a PR comment.
- **Cleanup**: closing a PR deletes both the Worker and the D1 database.

## Platform Detection

OpenStory automatically detects the deployment platform:

```typescript
import { getDeploymentPlatform } from '@/lib/utils/environment';

const platform = getDeploymentPlatform();
// Returns: 'cloudflare' | 'local' | 'unknown'
```
