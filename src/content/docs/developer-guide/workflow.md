---
title: Analyze Script Workflow
description: End-to-end pipeline that transforms a script into a storyboard with images, motion video, and music
section: Developer Guide
order: 5
---

The storyboard generation pipeline transforms a user's script into a complete storyboard with images, motion video, and music. It runs as a durable QStash workflow with automatic retries and checkpointing.

## High-Level Overview

The pipeline is organized into 5 phases, with significant parallelism within and between phases:

1. **Scene Splitting** — Stream-parse the script into scenes, create frames progressively
2. **Casting** — Extract characters and locations, match to library entries
3. **References & Prompts** — Generate character/location sheets and visual prompts
4. **Images + Motion/Music Prompts** — Image generation and prompt generation run in parallel
5. **Motion + Music Generation** — Generate videos, music, merge into final output

## Triggering Flow

The pipeline starts from server handlers in `src/functions/sequences.ts`:

- **`createSequenceFn`** — Creates a new sequence, triggers `/storyboard` workflow via QStash
- **`updateSequenceFn`** — Re-triggers if script, style, aspect ratio, or analysis model changed
- **`retryStoryboardFn`** — Retries a failed sequence (resets status to `processing`)

All use `triggerWorkflow()` from `src/lib/workflow/client.ts` which resolves the webhook URL and calls `WorkflowClient.trigger()`.

## Storyboard Workflow

**File:** `src/lib/workflows/storyboard-workflow.ts`

The entry point validates data, generates a poster, then delegates:

1. **Verify + clear** — Validates auth, loads sequence + style, deletes existing frames, sets status to `processing`
2. **Generate poster** — Creates a poster image for the video player empty state (non-critical, failures swallowed)
3. **Invoke analyze-script** — Delegates to the core workflow with 3 retries and exponential backoff
4. **Mark completed** — Sets status to `completed`, emits `generation.complete`

## Phase 1: Scene Splitting

**File:** `src/lib/workflows/scene-split-workflow.ts`

Streams the LLM response and creates frames progressively as scenes arrive:

- Parses incremental JSON chunks via `partial-json` and `createStreamingSceneParser()`
- On each complete scene: upserts frame in DB, emits real-time events
- Triggers preview image generation per scene (fire-and-forget) for instant visual feedback
- On title detection: updates the sequence title
- Reconciles all frames after streaming to handle QStash replay safety

**Output:** `{ scenes[], title, frameMapping[] }`

## Phase 2: Casting Characters & Locations

Two sub-workflows run in parallel:

**Talent Matching** (`src/lib/workflows/talent-matching-workflow.ts`):
1. Character extraction — LLM identifies characters with physical descriptions and consistency tags
2. Talent matching — If `suggestedTalentIds` provided, LLM matches characters to talent entries

**Location Matching** (`src/lib/workflows/location-matching-workflow.ts`):
1. Location extraction — LLM identifies locations with descriptions and color palettes
2. Location matching — If `suggestedLocationIds` provided, LLM matches to library locations

## Phase 3: References & Prompts

Three sub-workflows run in parallel:

- **Character Bible** — Generates reference sheet images per character (uses talent matches as reference)
- **Location Bible** — Generates establishing-shot references per location (uses library images when matched)
- **Visual Prompts** — Per-scene LLM calls generating `fullPrompt`, `negativePrompt`, and `continuity` data

## Phase 4: Images + Motion/Music Prompts

The key parallelization — two independent strands run simultaneously:

**Frame Images** (`src/lib/workflows/frame-images-workflow.ts`):
- Generates images for each scene with each selected model in parallel
- After each image, generates shot grid variants
- Uses character and location reference images for consistency

**Motion + Music Prompts** (`src/lib/workflows/motion-music-prompts-workflow.ts`):
- Snaps durations to video model capabilities upfront
- Runs motion prompt generation and music design in parallel:
  - Motion prompts: per-scene LLM calls for camera movement and timing
  - Music design: single LLM call classifying per-scene music needs + unified prompt
- Merges into `completeScenes[]` with `musicPrompt` and `musicTags`

## Phase 5: Motion + Music Generation

**File:** `src/lib/workflows/motion-batch-workflow.ts`

Only runs if `autoGenerateMotion` is enabled. A single orchestrator handles:

1. All frame motion workflows + optional music workflow invoked in parallel
2. Collects video URLs from DB (authoritative ordering)
3. Merges all frame videos into one sequence video
4. If music was generated, muxes audio onto the merged video

## Data Flow

Each phase enriches the Scene object:

| Field | Added By | Description |
|-------|----------|-------------|
| `sceneId`, `sceneNumber` | Phase 1 | Unique scene identifiers |
| `originalScript` | Phase 1 | `{ extract, dialogue }` |
| `metadata` | Phase 1 | `{ title, durationSeconds, location, timeOfDay, storyBeat }` |
| `prompts.visual` | Phase 3 | `{ fullPrompt, negativePrompt, components }` |
| `continuity` | Phase 3 | `{ characterTags, environmentTag, colorPalette, lightingSetup, styleTag }` |
| `prompts.motion` | Phase 4 | `{ fullPrompt, components, parameters }` |
| `musicDesign` | Phase 4 | `{ presence, style, mood, atmosphere }` |

## Real-Time Events

Events are emitted via Upstash Realtime on a per-sequence channel. Key events:

- `generation.phase:start` / `generation.phase:complete` — Phase transitions
- `generation.scene:new` / `generation.scene:updated` — Scene streaming progress
- `generation.frame:created` — Frame creation during streaming
- `generation.image:progress` — Image generation status
- `generation.video:progress` — Motion generation status
- `generation.audio:progress` — Music generation status
- `generation.complete` — Pipeline finished
- `generation.failed` — Pipeline failed with error

## Error Handling

Each workflow registers a `failureFunction` that:
1. Sanitizes errors via `sanitizeFailResponse()` (extracts inner errors, maps Cloudflare codes, truncates)
2. Updates the relevant record's status to `failed`
3. Emits failure events for the UI

**Retry strategy:** All external calls (image gen, motion gen, music gen) retry 3 times with exponential backoff. QStash manages step-level retries automatically.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/workflows/storyboard-workflow.ts` | Entry point: verify, poster, invoke |
| `src/lib/workflows/analyze-script-workflow.ts` | Core orchestration (phases 1-5) |
| `src/lib/workflows/scene-split-workflow.ts` | Streaming scene split + previews |
| `src/lib/workflows/talent-matching-workflow.ts` | Character extraction + matching |
| `src/lib/workflows/location-matching-workflow.ts` | Location extraction + matching |
| `src/lib/workflows/character-bible-workflow.ts` | Character sheet generation |
| `src/lib/workflows/location-bible-workflow.ts` | Location sheet generation |
| `src/lib/workflows/visual-prompt-workflow.ts` | Visual prompt generation |
| `src/lib/workflows/frame-images-workflow.ts` | Image + variant generation |
| `src/lib/workflows/motion-music-prompts-workflow.ts` | Motion + music prompt generation |
| `src/lib/workflows/motion-batch-workflow.ts` | Motion + music gen + merge |
