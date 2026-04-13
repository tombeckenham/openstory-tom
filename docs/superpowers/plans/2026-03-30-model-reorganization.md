# Model Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Curate image/video/music model lists, add open-source/proprietary badges to selectors, remove outdated models, and order by quality.

**Architecture:** Update model definitions in `models.ts` with new `license` and `qualityRank` fields, update the `buildFalModelOptions` switch in `image-generation.ts` for new/removed image models, generate motion endpoint schemas for new video models, and update all selector components to show license badges in a flat quality-ordered list.

**Tech Stack:** TypeScript, TanStack Start, shadcn/ui, fal.ai API, Drizzle ORM

**Spec:** `docs/superpowers/specs/2026-03-30-model-reorganization-design.md`

---

## File Map

### Create

- `src/lib/letzai/` — DELETE entire directory (LetzAI provider removed)

### Modify

- `src/lib/ai/models.ts` — Replace IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS, AUDIO_MODELS, EDIT_ENDPOINTS with curated lists; add `license`/`qualityRank` fields
- `src/lib/image/image-generation.ts` — Update `buildFalModelOptions` switch for new/removed models; remove LetzAI code path
- `src/lib/motion/endpoint-map.ts` — Regenerate to include new video endpoint schemas
- `src/components/model/base-model-selector.tsx` — Add badge rendering for open-source/proprietary
- `src/components/model/image-model-selector.tsx` — Replace tier groups with single quality-ordered list + badges
- `src/components/model/motion-model-selector.tsx` — Replace quality groups with single list + badges
- `src/components/model/music-model-selector.tsx` — Replace quality groups with single list + badges
- `src/components/model/model-badge.tsx` — Update for removed model keys
- `src/lib/ai/fal-pricing-data.ts` — Regenerate via `bun scripts/update-fal-pricing.ts`
- `src/lib/ai/models.test.ts` — Update test references for new model keys
- `src/lib/ai/fal-cost.test.ts` — Update test references
- `src/lib/motion/build-model-input.test.ts` — Update test references
- `src/lib/motion/assemble-motion-prompt.test.ts` — Update test references
- `src/lib/mocks/data-generators.ts` — Update mock model references

---

### Task 1: Update IMAGE_MODELS with new models and fields

**Files:**

- Modify: `src/lib/ai/models.ts`

This is the core data change for image models. We replace the entire `IMAGE_MODELS` object with the curated 10-model list, adding `license` and `qualityRank` fields, and removing `tier`.

- [ ] **Step 1: Read current models.ts and the spec**

Read `src/lib/ai/models.ts` and `docs/superpowers/specs/2026-03-30-model-reorganization-design.md` to understand the full current state and target state.

- [ ] **Step 2: Replace IMAGE_MODELS**

Replace the entire `IMAGE_MODELS` constant with the curated list. Each model gets:

- `license: 'open-source' | 'proprietary'` (replaces `tier`)
- `qualityRank: number` (1 = best, for display ordering)
- `provider` corrected to actual provider

The 10 models in quality order:

```typescript
export const IMAGE_MODELS = {
  nano_banana_2: {
    id: 'fal-ai/nano-banana-2' as const,
    name: 'Nano Banana 2',
    provider: 'Google',
    license: 'proprietary' as const,
    qualityRank: 1,
    description: "Google's latest fast image generation and editing model",
    maxPromptLength: 50000,
  },
  nano_banana_pro: {
    id: 'fal-ai/nano-banana-pro' as const,
    name: 'Nano Banana Pro',
    provider: 'Google',
    license: 'proprietary' as const,
    qualityRank: 2,
    description: 'Enhanced realism and typography',
    maxPromptLength: 50000,
  },
  grok_imagine_image: {
    id: 'xai/grok-imagine-image' as const,
    name: 'Grok Imagine Image',
    provider: 'Grok',
    license: 'proprietary' as const,
    qualityRank: 3,
    description: 'Aesthetic image generation with low censoring',
    maxPromptLength: 4000,
  },
  flux_2_max: {
    id: 'fal-ai/flux-2-max' as const,
    name: 'FLUX.2 Max',
    provider: 'Black Forest Labs',
    license: 'proprietary' as const,
    qualityRank: 4,
    description: 'Exceptional realism, precision, and consistency',
    maxPromptLength: 2000,
  },
  phota: {
    id: 'fal-ai/phota' as const,
    name: 'Phota',
    provider: 'Phota',
    license: 'proprietary' as const,
    qualityRank: 5,
    description: 'Character consistency via profiles',
    maxPromptLength: 2000,
  },
  hunyuan_image_v3: {
    id: 'fal-ai/hunyuan-image/v3/text-to-image' as const,
    name: 'Hunyuan Image v3',
    provider: 'Tencent',
    license: 'open-source' as const,
    qualityRank: 6,
    description: 'Open source with strong composition',
    maxPromptLength: 2000,
  },
  flux_2_dev: {
    id: 'fal-ai/flux-2' as const,
    name: 'FLUX.2 Dev',
    provider: 'Black Forest Labs',
    license: 'open-source' as const,
    qualityRank: 7,
    description: '32B open weights with native editing',
    maxPromptLength: 2000,
  },
  qwen_image: {
    id: 'fal-ai/qwen-image' as const,
    name: 'Qwen Image',
    provider: 'Alibaba',
    license: 'open-source' as const,
    qualityRank: 8,
    description: 'Apache 2.0, native 2K, text rendering',
    maxPromptLength: 2000,
  },
  hidream_i1: {
    id: 'fal-ai/hidream-i1-full' as const,
    name: 'HiDream I1',
    provider: 'HiDream',
    license: 'open-source' as const,
    qualityRank: 9,
    description: 'MIT licensed, 17B parameters',
    maxPromptLength: 2000,
  },
  seedream_v5: {
    id: 'fal-ai/bytedance/seedream/v5/lite/text-to-image' as const,
    name: 'Seedream 5',
    provider: 'ByteDance',
    license: 'proprietary' as const,
    qualityRank: 10,
    description: 'Unified generation and editing',
    maxPromptLength: 2000,
  },
} as const;
```

- [ ] **Step 3: Update EDIT_ENDPOINTS**

Replace the `EDIT_ENDPOINTS` constant with the full map (all 10 models have edit endpoints):

```typescript
export const EDIT_ENDPOINTS: Partial<Record<TextToImageModel, string>> = {
  nano_banana_2: 'fal-ai/nano-banana-2/edit',
  nano_banana_pro: 'fal-ai/nano-banana-pro/edit',
  grok_imagine_image: 'xai/grok-imagine-image/edit',
  flux_2_max: 'fal-ai/flux-2-max/edit',
  phota: 'fal-ai/phota/edit',
  hunyuan_image_v3: 'fal-ai/hunyuan-image/v3/instruct/edit',
  flux_2_dev: 'fal-ai/flux-2/edit',
  qwen_image: 'fal-ai/qwen-image-edit-2511',
  hidream_i1: 'fal-ai/hidream-e1-1',
  seedream_v5: 'fal-ai/bytedance/seedream/v5/lite/edit',
};
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/models.ts
git commit -m "feat: update IMAGE_MODELS with curated list and license/qualityRank fields #501"
```

---

### Task 2: Update buildFalModelOptions for new image models

**Files:**

- Modify: `src/lib/image/image-generation.ts`

The `buildFalModelOptions` function has an exhaustive switch on `params.model` (with a `never` check in the default case). We need to remove cases for deleted models and add cases for new models. This must compile with the IMAGE_MODELS from Task 1.

- [ ] **Step 1: Read image-generation.ts**

Read the full file to understand every switch case and the LetzAI code path.

- [ ] **Step 2: Remove LetzAI code path**

Remove the `if (params.model === 'letzai')` early return in `generateImageInternal` and the `generateLetzaiImage` function. Also remove the `letzai` case from the switch.

- [ ] **Step 3: Remove switch cases for deleted models**

Remove these cases from `buildFalModelOptions`:

- `flux_pro`, `flux_dev`, `flux_schnell`, `flux_krea_lora`, `flux_pro_v1_1_ultra` (entire block)
- `sdxl`, `sdxl_lightning` (entire block)
- `imagen4_preview_ultra`
- `nano_banana` (keep `nano_banana_pro` and `nano_banana_2`)
- `recraft_v3`
- `seedream_v4_5`
- `kling_image_v3`
- `flux_2_klein_4b`
- `gpt_image_1_5`
- `flux_2` (this key is renamed to `flux_2_dev` — keep the case body but change the key)

- [ ] **Step 4: Add switch cases for new models**

Add cases for each new model. Check each model's schema on fal.ai via `https://fal.ai/models/{model-path}/llms.txt` for authoritative parameter specs.

New cases needed:

- `flux_2_max` — similar to the old `flux_2` case but uses `fal-ai/flux-2-max` params (safety_tolerance, image_size, etc.)
- `flux_2_dev` — rename of old `flux_2` case
- `phota` — uses aspect_ratio, resolution, num_images
- `hunyuan_image_v3` — uses image_size, output_format, seed, num_images
- `qwen_image` — uses image_size, seed, num_images
- `seedream_v5` — uses image_size, seed, num_images, enable_safety_checker
- `hidream_i1` — rename of old `hidream_i1_full` case

- [ ] **Step 5: Verify the switch is exhaustive**

The default case has `const _exhaustive: never = params.model;` which will cause a type error if any model key is missing from the switch. Run typecheck:

```bash
bun typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/image/image-generation.ts
git commit -m "feat: update buildFalModelOptions for curated image model list #501"
```

---

### Task 3: Delete LetzAI integration

**Files:**

- Delete: `src/lib/letzai/` (entire directory)
- Modify: `src/lib/image/image-generation.ts` (remove LetzAI imports)

- [ ] **Step 1: Remove LetzAI imports from image-generation.ts**

Remove imports of LetzAI SDK functions and config. Remove the `LETZAI_DIMENSIONS` constant if present.

- [ ] **Step 2: Delete the LetzAI directory**

```bash
rm -rf src/lib/letzai/
```

- [ ] **Step 3: Verify no other files reference LetzAI**

Search for any remaining references:

```bash
grep -r "letzai" src/ --include="*.ts" --include="*.tsx" -l
```

Remove any remaining imports or references.

- [ ] **Step 4: Run typecheck**

```bash
bun typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove LetzAI integration (model removed) #501"
```

---

### Task 4: Update IMAGE_TO_VIDEO_MODELS

**Files:**

- Modify: `src/lib/ai/models.ts`

Replace the video model list with the curated 6 models. Add `license` and `qualityRank`.

- [ ] **Step 1: Replace IMAGE_TO_VIDEO_MODELS**

The 6 models in quality order. Keep existing entries for `veo3_1`, `kling_v3_pro`, and `grok_imagine_video` (they already exist). Add new entries for `ltx_2_3_pro`, `minimax_hailuo_02`, `seedance_v1_5_pro`. Remove `sora_2`, `kling_v2_5_turbo_pro`, `kling_o1`, `kling_v3_pro_no_audio`, `veo3`, `seedance_v1_pro`, `wan_v2_6_flash`.

Each model gets `license` and `qualityRank`. The `performance.quality` field stays for backward compatibility but `qualityRank` is the source of truth for ordering.

```typescript
export const IMAGE_TO_VIDEO_MODELS = {
  ltx_2_3_pro: {
    id: 'fal-ai/ltx-2.3/image-to-video',
    name: 'LTX 2.3 Pro',
    provider: 'Lightricks',
    license: 'open-source' as const,
    qualityRank: 1,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 15, quality: 'best' as const },
  },
  veo3_1: {
    id: 'fal-ai/veo3.1/image-to-video',
    name: 'Veo 3.1',
    provider: 'Google',
    license: 'proprietary' as const,
    qualityRank: 2,
    maxPromptLength: 20000,
    performance: { estimatedGenerationTime: 25, quality: 'best' as const },
  },
  kling_v3_pro: {
    id: 'fal-ai/kling-video/v3/pro/image-to-video',
    name: 'Kling v3 Pro',
    provider: 'Kling',
    license: 'proprietary' as const,
    qualityRank: 3,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 20, quality: 'best' as const },
  },
  grok_imagine_video: {
    id: 'xai/grok-imagine-video/image-to-video',
    name: 'Grok Imagine Video',
    provider: 'Grok',
    license: 'proprietary' as const,
    qualityRank: 4,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 20, quality: 'best' as const },
  },
  minimax_hailuo_02: {
    id: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
    name: 'MiniMax Hailuo 02',
    provider: 'MiniMax',
    license: 'proprietary' as const,
    qualityRank: 5,
    maxPromptLength: 2500,
    performance: { estimatedGenerationTime: 15, quality: 'best' as const },
  },
  seedance_v1_5_pro: {
    id: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    name: 'Seedance 1.5 Pro',
    provider: 'ByteDance',
    license: 'proprietary' as const,
    qualityRank: 6,
    maxPromptLength: 4096,
    performance: { estimatedGenerationTime: 12, quality: 'best' as const },
  },
} as const;
```

- [ ] **Step 2: Update IMAGE_TO_VIDEO_MODEL_KEYS**

```typescript
export const IMAGE_TO_VIDEO_MODEL_KEYS = [
  'grok_imagine_video',
  'kling_v3_pro',
  'ltx_2_3_pro',
  'minimax_hailuo_02',
  'seedance_v1_5_pro',
  'veo3_1',
] as const satisfies readonly ImageToVideoModel[];
```

- [ ] **Step 3: Verify DEFAULT_VIDEO_MODEL is still valid**

`DEFAULT_VIDEO_MODEL` should remain `'kling_v3_pro'` — confirm it's still in the new object.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/models.ts
git commit -m "feat: update IMAGE_TO_VIDEO_MODELS with curated list #501"
```

---

### Task 5: Generate motion endpoint schemas for new video models

**Files:**

- Modify: `src/lib/motion/endpoint-map.ts` (regenerated)
- Modify: `src/lib/motion/generated/types.gen.ts` (regenerated)

New video models (`ltx_2_3_pro`, `minimax_hailuo_02`, `seedance_v1_5_pro`) need their API schemas in MOTION_INPUT_SCHEMAS. Removed models (`sora_2`, `kling_v2_5_turbo_pro`, `kling_o1`, `veo3`, `seedance_v1_pro`, `wan_v2_6_flash`) should be removed from schemas.

- [ ] **Step 1: Check how endpoint schemas are generated**

Read `src/lib/motion/endpoint-map.ts` header comments and any generation scripts to understand the process.

- [ ] **Step 2: Fetch llms.txt for each new endpoint**

Verify API parameters for each new model:

- `https://fal.ai/models/fal-ai/ltx-2.3/image-to-video/llms.txt`
- `https://fal.ai/models/fal-ai/minimax/hailuo-02/pro/image-to-video/llms.txt`
- `https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video/llms.txt`

- [ ] **Step 3: Run the endpoint schema generator**

Run whatever script generates the endpoint map. If no script exists, manually add Zod schemas for the 3 new endpoints following the existing pattern in `endpoint-map.ts`.

- [ ] **Step 4: Remove schemas for deleted video endpoints**

Remove schema entries for:

- `fal-ai/sora-2/image-to-video`
- `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`
- `fal-ai/kling-video/o1/image-to-video`
- `fal-ai/veo3` (text-to-video, not image-to-video)
- `fal-ai/bytedance/seedance/v1/pro/image-to-video`
- `wan/v2.6/image-to-video/flash`

- [ ] **Step 5: Run typecheck**

```bash
bun typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/motion/
git commit -m "feat: update motion endpoint schemas for new video models #501"
```

---

### Task 6: Update AUDIO_MODELS

**Files:**

- Modify: `src/lib/ai/models.ts`

Add new music models (`minimax_music_v2`, `lyria_2`), add `license`/`qualityRank` to existing models, remove `ace_step_audio_to_audio` and `beatoven_music`.

- [ ] **Step 1: Update AUDIO_MODELS**

Keep `ace_step`, `mmaudio_v2`, `elevenlabs_sfx`, `elevenlabs_music` (existing). Add `minimax_music_v2` and `lyria_2`. Remove `ace_step_audio_to_audio` and `beatoven_music`. Add `license` and `qualityRank` to each.

```typescript
export const AUDIO_MODELS = {
  elevenlabs_music: {
    id: 'fal-ai/elevenlabs/music' as const,
    name: 'ElevenLabs Music',
    provider: 'ElevenLabs',
    license: 'proprietary' as const,
    qualityRank: 1,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsInstrumental: true,
      maxDuration: 600,
      defaultDuration: 60,
      supportedFormats: ['mp3'],
    },
    performance: { estimatedGenerationTime: 30, quality: 'best' },
  },
  minimax_music_v2: {
    id: 'fal-ai/minimax-music/v2' as const,
    name: 'MiniMax Music v2',
    provider: 'MiniMax',
    license: 'proprietary' as const,
    qualityRank: 2,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsLyrics: true,
      supportsInstrumental: true,
      maxDuration: 300,
      defaultDuration: 60,
      supportedFormats: ['mp3'],
    },
    performance: { estimatedGenerationTime: 30, quality: 'best' },
  },
  ace_step: {
    id: 'fal-ai/ace-step/prompt-to-audio' as const,
    name: 'ACE-Step 1.5',
    provider: 'ACE Studio',
    license: 'open-source' as const,
    qualityRank: 3,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsLyrics: true,
      supportsInstrumental: true,
      maxDuration: 240,
      defaultDuration: 60,
      supportedFormats: ['wav'],
    },
    performance: { estimatedGenerationTime: 20, quality: 'best' },
  },
  lyria_2: {
    id: 'fal-ai/lyria2' as const,
    name: 'Lyria 2',
    provider: 'Google',
    license: 'proprietary' as const,
    qualityRank: 4,
    type: 'music' as const,
    capabilities: {
      supportsPrompt: true,
      supportsInstrumental: true,
      maxDuration: 30,
      defaultDuration: 30,
      supportedFormats: ['wav'],
    },
    performance: { estimatedGenerationTime: 15, quality: 'best' },
  },
  // SFX models — unchanged, kept for internal use
  mmaudio_v2: {
    id: 'fal-ai/mmaudio-v2' as const,
    name: 'MMAudio V2 (Video-to-Audio)',
    provider: 'MMAudio',
    license: 'open-source' as const,
    qualityRank: 5,
    type: 'sfx' as const,
    capabilities: {
      supportsPrompt: true,
      supportsVideoInput: true,
      maxDuration: 8,
      defaultDuration: 8,
      supportedFormats: ['wav'],
    },
    performance: { estimatedGenerationTime: 10, quality: 'good' },
  },
  elevenlabs_sfx: {
    id: 'fal-ai/elevenlabs/sound-effects' as const,
    name: 'ElevenLabs Sound Effects',
    provider: 'ElevenLabs',
    license: 'proprietary' as const,
    qualityRank: 6,
    type: 'sfx' as const,
    capabilities: {
      supportsPrompt: true,
      maxDuration: 22,
      defaultDuration: 5,
      supportedFormats: ['mp3'],
    },
    performance: { estimatedGenerationTime: 5, quality: 'good' },
  },
} as const;
```

- [ ] **Step 2: Update AUDIO_MODEL_KEYS**

```typescript
export const AUDIO_MODEL_KEYS = [
  'ace_step',
  'elevenlabs_music',
  'elevenlabs_sfx',
  'lyria_2',
  'minimax_music_v2',
  'mmaudio_v2',
] as const satisfies readonly AudioModel[];
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/models.ts
git commit -m "feat: update AUDIO_MODELS with curated music models #501"
```

---

### Task 7: Update base-model-selector with badge support

**Files:**

- Modify: `src/components/model/base-model-selector.tsx`

Add a `badge` field to `ModelItem` and render it as a small pill next to the model name.

- [ ] **Step 1: Read base-model-selector.tsx**

Read the full current file.

- [ ] **Step 2: Add badge to ModelItem type and render it**

Update the `ModelItem` type:

```typescript
type ModelItem = {
  id: string;
  name: string;
  group: string;
  badge?: 'open-source' | 'proprietary';
};
```

In the `DropdownMenuCheckboxItem` render, add the badge pill after the model name:

```tsx
<DropdownMenuCheckboxItem
  key={model.id}
  checked={isSelected}
  onCheckedChange={(checked) => handleToggle(model.id, checked)}
  onSelect={(e) => e.preventDefault()}
  disabled={isDisabled}
  className="cursor-pointer"
>
  <span className="flex items-center gap-2 text-sm">
    <span className="truncate">{model.name}</span>
    {model.badge === 'open-source' && (
      <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
        Open Source
      </span>
    )}
  </span>
</DropdownMenuCheckboxItem>
```

Only show the badge for open-source models — proprietary is the assumed default, no need to label it.

- [ ] **Step 3: Make groups optional**

When there is only one group, skip rendering the group header. Update the group rendering logic:

```tsx
const showGroupHeaders = groupOrder.length > 1;
```

Then conditionally render the `DropdownMenuLabel` for group names only when `showGroupHeaders` is true.

- [ ] **Step 4: Commit**

```bash
git add src/components/model/base-model-selector.tsx
git commit -m "feat: add open-source badge to model selector dropdown #501"
```

---

### Task 8: Update concrete model selectors

**Files:**

- Modify: `src/components/model/image-model-selector.tsx`
- Modify: `src/components/model/motion-model-selector.tsx`
- Modify: `src/components/model/music-model-selector.tsx`

All three selectors change from multi-group (tier/quality) to a single quality-ordered group with license badges.

- [ ] **Step 1: Update image-model-selector.tsx**

Replace `TIER_ORDER` with a single group. Pass `license` as `badge`:

```tsx
const GROUP_ORDER = ['all'] as const;

// In the models useMemo:
const models = useMemo(
  () =>
    Object.entries(IMAGE_MODELS)
      .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
      .map(([key, m]) => ({
        id: key,
        name: m.name,
        group: 'all',
        badge: m.license,
      })),
  []
);
```

Update the `BaseModelSelector` call to use `GROUP_ORDER`.

- [ ] **Step 2: Update motion-model-selector.tsx**

Same pattern — single group, quality-ordered, with badges:

```tsx
const GROUP_ORDER = ['all'] as const;

// In the models useMemo:
const models = useMemo(
  () =>
    Object.entries(IMAGE_TO_VIDEO_MODELS)
      .filter(([key]) => {
        if (!isValidImageToVideoModel(key)) return false;
        return aspectRatio
          ? isModelCompatibleWithAspectRatio(key, aspectRatio)
          : true;
      })
      .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
      .map(([key, m]) => ({
        id: key,
        name: m.name,
        group: 'all',
        badge: m.license,
      })),
  [aspectRatio]
);
```

- [ ] **Step 3: Update music-model-selector.tsx**

Same pattern:

```tsx
const GROUP_ORDER = ['all'] as const;

const models = useMemo(
  () =>
    Object.entries(AUDIO_MODELS)
      .filter(([key, m]) => {
        if (!isValidAudioModel(key)) return false;
        return m.type === 'music';
      })
      .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
      .map(([key, m]) => ({
        id: key,
        name: m.name,
        group: 'all',
        badge: m.license,
      })),
  []
);
```

- [ ] **Step 4: Commit**

```bash
git add src/components/model/image-model-selector.tsx src/components/model/motion-model-selector.tsx src/components/model/music-model-selector.tsx
git commit -m "feat: update model selectors with quality ordering and license badges #501"
```

---

### Task 9: Update tests and mocks

**Files:**

- Modify: `src/lib/ai/models.test.ts`
- Modify: `src/lib/ai/fal-cost.test.ts`
- Modify: `src/lib/motion/build-model-input.test.ts`
- Modify: `src/lib/motion/assemble-motion-prompt.test.ts`
- Modify: `src/lib/mocks/data-generators.ts`

- [ ] **Step 1: Read each test file**

Read all test files to understand what references need updating.

- [ ] **Step 2: Update models.test.ts**

Replace references to removed model keys (`flux_pro`, `sora_2`, etc.) with valid keys from the new lists. Update any assertions about model counts or specific model properties.

- [ ] **Step 3: Update fal-cost.test.ts**

Replace endpoint references for removed models with new endpoints. Update pricing expectations.

- [ ] **Step 4: Update motion test files**

In `build-model-input.test.ts` and `assemble-motion-prompt.test.ts`, replace `sora_2` references with a valid video model key like `kling_v3_pro`.

- [ ] **Step 5: Update data-generators.ts**

Replace `flux_pro` in mock model choices with `nano_banana_2`.

- [ ] **Step 6: Run all tests**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/models.test.ts src/lib/ai/fal-cost.test.ts src/lib/motion/build-model-input.test.ts src/lib/motion/assemble-motion-prompt.test.ts src/lib/mocks/data-generators.ts
git commit -m "test: update tests for curated model lists #501"
```

---

### Task 10: Regenerate fal pricing data

**Files:**

- Modify: `src/lib/ai/fal-pricing-data.ts` (auto-generated)

- [ ] **Step 1: Run the pricing update script**

```bash
bun scripts/update-fal-pricing.ts
```

This will fetch current pricing for all endpoints and regenerate the file. New endpoints will be added, removed endpoints will be dropped.

- [ ] **Step 2: Verify the file has entries for new endpoints**

Check that pricing entries exist for:

- `fal-ai/flux-2-max`
- `fal-ai/phota`
- `fal-ai/hunyuan-image/v3/text-to-image`
- `fal-ai/qwen-image`
- `fal-ai/ltx-2.3/image-to-video`
- `fal-ai/minimax/hailuo-02/pro/image-to-video`
- `fal-ai/bytedance/seedance/v1.5/pro/image-to-video`
- `fal-ai/minimax-music/v2`
- `fal-ai/lyria2`

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/fal-pricing-data.ts
git commit -m "chore: regenerate fal pricing data for new models #501"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run typecheck**

```bash
bun typecheck
```

Fix any type errors. The exhaustive switch in `buildFalModelOptions` and the `satisfies` on `IMAGE_TO_VIDEO_MODEL_KEYS` / `AUDIO_MODEL_KEYS` will catch missing entries.

- [ ] **Step 2: Run all tests**

```bash
bun test
```

- [ ] **Step 3: Run build**

```bash
bun run build
```

- [ ] **Step 4: Start dev server and verify selectors**

```bash
bun dev
```

Open the app, navigate to a sequence, and verify:

- Image model selector shows 10 models in quality order with "Open Source" badges on 4 of them
- Video model selector shows 6 models with "Open Source" badge on LTX 2.3 Pro
- Music model selector shows 4 models with "Open Source" badge on ACE-Step 1.5
- Selecting each model works correctly

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "fix: final adjustments from verification #501"
```
