# Model Reorganization Design

**Issue:** #501 — Update models and promote open source
**Date:** 2026-03-30

## Goal

Curate the model lists across image, video, and music categories to highlight open-source models, remove outdated/redundant entries, and order by quality. The current selectors are disorganized with 25+ image models and several discontinued entries (Sora 2, SDXL Lightning, etc.).

## Design Decisions

- **Single quality-ordered list** per category (no fast/draft vs HQ split)
- **Open Source / Proprietary badges** inline on each model in the selector
- **Quality ordering** based on Artificial Analysis rankings as starting point, to be refined by a custom evaluation suite (separate issue)
- **Fast/draft variants removed** — a future "draft mode" toggle will select the fast version of whichever model is chosen
- **SFX models unchanged** — existing MMAudio V2 and ElevenLabs SFX stay in the codebase but are not part of this redesign
- **Edit endpoint required** — all image models must have an edit endpoint for reference image generation (characters, locations)

## Data Model Changes

### `models.ts` — Model definition structure

Replace `tier` with `license` and `qualityRank`:

```typescript
// Before
{
  id: 'fal-ai/nano-banana-2',
  name: 'Nano Banana 2',
  provider: 'Fal.ai',
  tier: 'high quality',
  description: '...',
  maxPromptLength: 50000,
}

// After
{
  id: 'fal-ai/nano-banana-2',
  name: 'Nano Banana 2',
  provider: 'Google',
  license: 'proprietary',
  qualityRank: 1,
  description: '...',
  maxPromptLength: 50000,
}
```

- `license`: `'open-source' | 'proprietary'`
- `qualityRank`: integer, 1 = best. Used for display ordering.
- `tier`: removed from image models
- `provider`: corrected to actual provider (not "Fal.ai")

### Video models (`IMAGE_TO_VIDEO_MODELS`)

Add `license` and `qualityRank`. The `performance.quality` field (currently `'good'` | `'best'`) is replaced by `qualityRank` for ordering.

### Audio models (`AUDIO_MODELS`)

Add `license` and `qualityRank` to music models. SFX models stay unchanged.

## Curated Model Lists

### Image Models (10 models, all with edit endpoints)

| Rank | Model              | Key                  | Endpoint                                          | Edit Endpoint                            | Provider          | License     | Notes                              |
| ---- | ------------------ | -------------------- | ------------------------------------------------- | ---------------------------------------- | ----------------- | ----------- | ---------------------------------- |
| 1    | Nano Banana 2      | `nano_banana_2`      | `fal-ai/nano-banana-2`                            | `fal-ai/nano-banana-2/edit`              | Google            | Proprietary | ELO 1258, Feb 2026                 |
| 2    | Nano Banana Pro    | `nano_banana_pro`    | `fal-ai/nano-banana-pro`                          | `fal-ai/nano-banana-pro/edit`            | Google            | Proprietary | ELO 1214                           |
| 3    | Grok Imagine Image | `grok_imagine_image` | `xai/grok-imagine-image`                          | `xai/grok-imagine-image/edit`            | Grok              | Proprietary | Low censoring, aesthetic           |
| 4    | FLUX.2 Max         | `flux_2_max`         | `fal-ai/flux-2-max`                               | `fal-ai/flux-2-max/edit`                 | Black Forest Labs | Proprietary | ELO 1200, configurable safety      |
| 5    | Phota              | `phota`              | `fal-ai/phota`                                    | `fal-ai/phota/edit`                      | Phota             | Proprietary | Character consistency via profiles |
| 6    | Hunyuan Image v3   | `hunyuan_image_v3`   | `fal-ai/hunyuan-image/v3/text-to-image`           | `fal-ai/hunyuan-image/v3/instruct/edit`  | Tencent           | Open Source | Open source, strong composition    |
| 7    | FLUX.2 Dev         | `flux_2_dev`         | `fal-ai/flux-2`                                   | `fal-ai/flux-2/edit`                     | Black Forest Labs | Open Source | 32B, open weights, Nov 2025        |
| 8    | Qwen Image         | `qwen_image`         | `fal-ai/qwen-image`                               | `fal-ai/qwen-image-edit-2511`            | Alibaba           | Open Source | Apache 2.0, ELO 1151, 2K native    |
| 9    | HiDream I1         | `hidream_i1`         | `fal-ai/hidream-i1-full`                          | `fal-ai/hidream-e1-1`                    | HiDream           | Open Source | MIT, 17B params                    |
| 10   | Seedream 5         | `seedream_v5`        | `fal-ai/bytedance/seedream/v5/lite/text-to-image` | `fal-ai/bytedance/seedream/v5/lite/edit` | ByteDance         | Proprietary | Feb 2026, unified gen+edit         |

**Removed:** Nano Banana (original), FLUX.1 Schnell, FLUX.1 Dev, FLUX Pro, FLUX Pro v1.1 Ultra, FLUX Krea LoRA, FLUX 2 (renamed to FLUX.2 Dev), FLUX 2 Klein 4B, SDXL, SDXL Lightning, Imagen 4 Ultra, Recraft v3, Seedream 4.5, Kling Image v3, LetzAI, GPT Image 1.5 (excessive censoring), Grok Imagine Image (stays — was incorrectly in removal list earlier).

**Default:** `nano_banana_2` (unchanged)

### Video Models (6 models)

| Rank | Model              | Key                  | Endpoint                                            | Provider   | License     | Notes                            |
| ---- | ------------------ | -------------------- | --------------------------------------------------- | ---------- | ----------- | -------------------------------- |
| 1    | LTX 2.3 Pro        | `ltx_2_3_pro`        | `fal-ai/ltx-2.3/image-to-video`                     | Lightricks | Open Source | Apache 2.0, 4K, audio, Mar 2026  |
| 2    | Veo 3.1            | `veo3_1`             | `fal-ai/veo3.1/image-to-video`                      | Google     | Proprietary | 4K, best lip sync + audio        |
| 3    | Kling v3 Pro       | `kling_v3_pro`       | `fal-ai/kling-video/v3/pro/image-to-video`          | Kling      | Proprietary | Feb 2026, multi-shot, audio      |
| 4    | Grok Imagine Video | `grok_imagine_video` | `xai/grok-imagine-video/image-to-video`             | Grok       | Proprietary | Audio, low censoring             |
| 5    | MiniMax Hailuo 02  | `minimax_hailuo_02`  | `fal-ai/minimax/hailuo-02/pro/image-to-video`       | MiniMax    | Proprietary | #2 benchmark, $0.08/sec          |
| 6    | Seedance 1.5 Pro   | `seedance_v1_5_pro`  | `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | ByteDance  | Proprietary | Dec 2025, audio, start/end frame |

**Removed:** Sora 2 (discontinued), Kling v2.5 Turbo Pro (old), Kling O1 (superseded), Kling v3 Pro no-audio (duplicate endpoint), Veo 3 (superseded by 3.1), Seedance v1 Pro (superseded), Wan 2.6 Flash (placeholder endpoint).

**Default:** `kling_v3_pro` (unchanged)

### Music Models (4 models)

| Rank | Model            | Key                | Endpoint                          | Provider   | License     | Notes                            |
| ---- | ---------------- | ------------------ | --------------------------------- | ---------- | ----------- | -------------------------------- |
| 1    | ElevenLabs Music | `elevenlabs_music` | `fal-ai/elevenlabs/music`         | ElevenLabs | Proprietary | Studio-grade, commercial-cleared |
| 2    | MiniMax Music v2 | `minimax_music_v2` | `fal-ai/minimax-music/v2`         | MiniMax    | Proprietary | #1 on fal, $0.03/gen             |
| 3    | ACE-Step 1.5     | `ace_step`         | `fal-ai/ace-step/prompt-to-audio` | ACE Studio | Open Source | Beats Suno v5, $0.0002/sec       |
| 4    | Lyria 2          | `lyria_2`          | `fal-ai/lyria2`                   | Google     | Proprietary | Good instrumental                |

**Removed:** ACE-Step Remix (audio-to-audio variant), Beatoven Music (SFX-only on fal).

**Unchanged:** MMAudio V2 and ElevenLabs SFX stay in `AUDIO_MODELS` for internal use but are not part of the music selector redesign.

**Default:** `elevenlabs_music` (unchanged)

### Edit Endpoints

All image models have edit endpoints. Updated map:

```typescript
export const EDIT_ENDPOINTS: Partial<Record<TextToImageModel, string>> = {
  nano_banana_2: 'fal-ai/nano-banana-2/edit',
  nano_banana_pro: 'fal-ai/nano-banana-pro/edit',
  grok_imagine_image: 'xai/grok-imagine-image/edit',
  flux_2_max: 'fal-ai/flux-2-max/edit',
  phota: 'fal-ai/phota/edit',
  qwen_image: 'fal-ai/qwen-image-edit-2511',
  flux_2_dev: 'fal-ai/flux-2/edit',
  hidream_i1: 'fal-ai/hidream-e1-1',
  hunyuan_image_v3: 'fal-ai/hunyuan-image/v3/instruct/edit',
  seedream_v5: 'fal-ai/bytedance/seedream/v5/lite/edit',
};
```

## UI Changes

### `base-model-selector.tsx`

Add optional `badge` to `ModelItem`:

```typescript
type ModelItem = {
  id: string;
  name: string;
  group: string;
  badge?: 'open-source' | 'proprietary';
};
```

Render the badge as a small pill next to the model name in the dropdown:

- Open Source: green background, green text
- Proprietary: muted/secondary style

### `image-model-selector.tsx`

- Remove `TIER_ORDER`
- Map models to a single group, pass `license` as `badge`
- Models are already quality-ordered from the data

### `motion-model-selector.tsx`

- Remove `QUALITY_ORDER` groups
- Single group, quality-ordered, with badges
- Aspect ratio filtering stays

### `music-model-selector.tsx`

- Remove `QUALITY_ORDER` groups
- Single group, quality-ordered, with badges
- Music-only filter stays

### `model-selector.tsx` (analysis/LLM)

No changes — keeps fast/premium grouping.

## Migration Safety

Existing sequences/frames may reference removed model keys in the database. The `safeTextToImageModel()`, `safeImageToVideoModel()`, and `safeAudioModel()` functions already handle this — invalid keys log a warning and fall back to the default. No database migration needed.

## New Video Model Endpoints

New video models (LTX 2.3 Pro, MiniMax Hailuo 02, Seedance 1.5 Pro) need entries in `MOTION_INPUT_SCHEMAS` (from `src/lib/motion/endpoint-map.ts`). These schemas are generated from fal.ai OpenAPI specs — the endpoint map generator needs to be run for the new endpoints.

## Follow-up Issue

Create a new GitHub issue for a model evaluation suite:

- Define a set of OpenStory-specific prompts (cinematic shots, character close-ups, lighting/mood, continuity)
- Script to run each model through the prompt set
- Save results to R2
- Comparison view for reviewing results
- Use results to refine `qualityRank` ordering
