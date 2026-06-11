---
title: Deploy to Cloudflare
description: Deploy OpenStory to Cloudflare Workers with D1 and R2
section: Developer Guide
order: 10
---

OpenStory deploys to Cloudflare Workers, using D1 (SQLite) for the database and R2 for media storage.

## One-Click Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openstory-so/openstory)

The deploy button clones the repo into your GitHub/GitLab account, provisions the resources declared in `wrangler.jsonc`, prompts for the secrets listed in `.dev.vars.example`, and sets up CI for your copy.

The created repo is an independent clone, not a fork — there's no upstream link for GitHub's "Sync fork" button. To pull future OpenStory updates into a button-deployed copy, add the upstream remote manually (`git remote add upstream https://github.com/openstory-so/openstory && git pull upstream main`). If you'd rather start from a real fork, fork on GitHub first, then connect the fork to [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) in the Cloudflare dashboard (or deploy from a local clone with `bun setup --prod`).

AI keys (`FAL_KEY`, `OPENROUTER_KEY`) are deliberately not part of the deploy prompts — every field in that dialog is mandatory, and a placeholder value would be worse than none. Add them after deploy, either per team in the app (Settings → API Keys) or server-wide with `wrangler secret put`.

## Guided Setup

From your own clone, `bun setup --prod` walks through everything interactively: production env vars (`.env.production`), R2 domains + CORS, optional services, pushing secrets to Cloudflare and GitHub, and the first deploy. `bun setup --deploy` re-runs just the secrets-push + deploy phase, and `bun setup --pr-preview` pushes preview secrets to the GitHub `staging` environment used by PR preview deploys.

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

# Deploy to production (typegen, CLOUDFLARE_ENV=production build, wrangler deploy)
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

| Variable                                    | Description                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                        | Better Auth signing secret                                                            |
| `VITE_APP_URL`                              | Public URL of the deployment                                                          |
| `FAL_KEY`                                   | fal.ai API key for image/video generation                                             |
| `OPENROUTER_KEY`                            | OpenRouter API key for LLM script analysis                                            |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth credentials                                                              |
| `EMAIL_FROM`                                | Sender address for transactional email (domain onboarded in Cloudflare Email Service) |

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
