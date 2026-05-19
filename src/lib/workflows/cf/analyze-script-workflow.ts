/**
 * Cloudflare Workflows port of `analyzeScriptWorkflow` — the deepest
 * orchestrator in the system. Sequences scene-split → talent/location
 * matching → character/location bibles + visual prompts → frame images +
 * motion/music prompts → motion-batch.
 *
 * Mirrors the QStash version (`src/lib/workflows/analyze-script-workflow.ts`)
 * phase for phase. Key differences:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Every `context.invoke('child', { workflow, body })` becomes a
 *     `spawnAndAwaitChild` Pattern 3 call (cf/await-child.ts). Parallel
 *     `Promise.all([context.invoke, context.invoke])` becomes
 *     `Promise.all` over `spawnAndAwaitChild` calls; we use
 *     `Promise.allSettled` where the QStash original individually checked
 *     `.isFailed` so a single child failure surfaces as a typed error
 *     instead of an unhandled rejection.
 *
 * Two child workflows are NOT yet CF-ported and stubbed inside `step.do`
 * with `NonRetryableError` so the dispatcher keeps this workflow on QStash
 * until they land:
 *
 *   - `scene-split` (Gap C — needs LLM streaming inside `step.do`).
 *   - `motion-batch` (no CF port yet; the inner motion/music/merge tree
 *     stays on QStash).
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `analyze-script` to `'cloudflare'`. See
 * docs/investigations/cloudflare-workflows-poc.md.
 */

import { sanitizeScriptContent } from '@/lib/ai/prompt-validation';
import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { recordWorkflowTrace } from '@/lib/observability/langfuse';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/cf/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import {
  isOpenRouterAuthError,
  sanitizeFailResponse,
} from '@/lib/workflow/sanitize-fail-response';
import type {
  AnalyzeScriptWorkflowInput,
  BatchMotionMusicWorkflowInput,
  CharacterBibleWorkflowInput,
  FrameImagesWorkflowInput,
  FrameImagesWorkflowResult,
  LocationBibleWorkflowInput,
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput,
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput,
  VisualPromptWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import {
  computeFrameImagesHashFromDto,
  type FrameImageSceneSnapshot,
} from '@/lib/workflows/sheet-snapshots';
import type {
  CharacterMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const PARENT_BINDING_NAME = 'ANALYZE_SCRIPT_WORKFLOW' as const;

export class AnalyzeScriptWorkflow extends OpenStoryWorkflowEntrypoint<AnalyzeScriptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<Scene[]> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const {
      sequenceId,
      script,
      aspectRatio,
      styleConfig,
      analysisModelId,
      imageModel,
      imageModels: imageModelsInput,
      videoModel,
      autoGenerateMotion = false,
      autoGenerateMusic = false,
      musicModel,
      suggestedTalentIds,
      suggestedLocationIds,
    } = input;

    const imageModels = resolveImageModels(imageModelsInput, imageModel);

    // Top-level validation — base class re-wraps as CF NonRetryableError.
    if (!script) {
      throw new WorkflowValidationError('No script found');
    }

    // Record start time of analysis (used for analysis-duration metric below).
    const startTime = await step.do('start-time', () =>
      Promise.resolve(Date.now())
    );

    // ----------------------------------------------------------------------
    // PHASE 1: scene-split (LLM stream → scenes/bibles/frameMapping)
    // ----------------------------------------------------------------------
    await step.do('phase-1-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 1,
        phaseName: 'Analyzing script…',
      });
    });

    // Load sequence elements. Vision MUST be terminal before scene-split.
    // See QStash original for the full rationale.
    const elements = await step.do('load-elements', async () => {
      if (!sequenceId) return [];
      const list = await scopedDb.sequenceElements.list(sequenceId);
      const stillRunning = list.filter(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      );
      if (stillRunning.length > 0) {
        // NonRetryableError (not WorkflowValidationError) because the base
        // class's re-wrap only runs at the runImpl catch boundary; a throw
        // inside step.do gets retried by CF's step machinery first.
        throw new NonRetryableError(
          `Element vision is still running for ${stillRunning.length} element(s). ` +
            `Wait for vision analysis to finish before regenerating.`,
          'WorkflowValidationError'
        );
      }
      return list;
    });

    const elementsMinimal = elements.map((el) => ({
      id: el.id,
      token: el.token,
      description: el.description,
      imageUrl: el.imageUrl,
      consistencyTag: el.consistencyTag,
    }));

    // scene-split (Gap C) — not yet CF-ported. Build the payload for diff
    // parity with the QStash original, then surface a non-retryable validation
    // error so the dispatcher falls back to QStash. The payload itself is
    // discarded for now; once the child lands, replace the throw with a
    // `spawnAndAwaitChild` against `SCENE_SPLIT_WORKFLOW`.
    const sceneSplitResult = await step.do(
      'spawn-scene-split',
      async (): Promise<SceneSplitWorkflowResult> => {
        const _payload: SceneSplitWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          promptName: 'phase/scene-splitting-chat',
          aspectRatio,
          script: sanitizeScriptContent(script),
          styleConfig,
          modelId: analysisModelId,
          elements: elementsMinimal,
        };
        void _payload;
        throw new NonRetryableError(
          'Child invocation pending scene-split port; route this workflow via QStash',
          'WorkflowValidationError'
        );
      }
    );

    const {
      scenes,
      frameMapping,
      characterBible,
      locationBible,
      elementBible,
    } = sceneSplitResult;

    // ----------------------------------------------------------------------
    // PHASE 2: talent + location matching in parallel
    // ----------------------------------------------------------------------
    const talentBinding = this.env.TALENT_MATCHING_WORKFLOW;
    if (!talentBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] TALENT_MATCHING_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }
    const locationMatchingBinding = this.env.LOCATION_MATCHING_WORKFLOW;
    if (!locationMatchingBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] LOCATION_MATCHING_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }

    const [talentSettled, locationMatchSettled] = await Promise.allSettled([
      spawnAndAwaitChild<
        TalentMatchingWorkflowInput,
        TalentMatchingWorkflowOutput
      >(step, {
        binding: talentBinding as Workflow<
          TalentMatchingWorkflowInput & {
            _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
          }
        >,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `talent-matching:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          sequenceId,
          userId: input.userId,
          teamId: input.teamId,
          analysisModelId,
          suggestedTalentIds,
          characterBible,
        },
        spawnStepName: 'spawn-talent-matching',
        awaitStepName: 'await-talent-matching',
      }),
      spawnAndAwaitChild<
        LocationMatchingWorkflowInput,
        LocationMatchingWorkflowOutput
      >(step, {
        binding: locationMatchingBinding as Workflow<
          LocationMatchingWorkflowInput & {
            _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
          }
        >,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `location-matching:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          sequenceId,
          userId: input.userId,
          teamId: input.teamId,
          analysisModelId,
          suggestedLocationIds,
          locationBible,
        },
        spawnStepName: 'spawn-location-matching',
        awaitStepName: 'await-location-matching',
      }),
    ]);

    if (talentSettled.status === 'rejected') {
      throw new Error(
        `Character sheet generation failed: ${String(talentSettled.reason)}`
      );
    }
    if (locationMatchSettled.status === 'rejected') {
      throw new Error(
        `Location sheet generation failed: ${String(locationMatchSettled.reason)}`
      );
    }
    const { matches: talentCharacterMatches } = talentSettled.value;
    const { matches: libraryLocationMatches } = locationMatchSettled.value;

    // ----------------------------------------------------------------------
    // PHASE 3: character bible + location bible + visual prompts in parallel
    // ----------------------------------------------------------------------
    await step.do('phase-3-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 3,
        phaseName: 'Generating references & prompts…',
      });
    });

    const characterBibleBinding = this.env.CHARACTER_BIBLE_WORKFLOW;
    if (!characterBibleBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] CHARACTER_BIBLE_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }
    const locationBibleBinding = this.env.LOCATION_BIBLE_WORKFLOW;
    if (!locationBibleBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] LOCATION_BIBLE_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }
    const visualPromptBinding = this.env.VISUAL_PROMPT_WORKFLOW;
    if (!visualPromptBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] VISUAL_PROMPT_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }

    const [charSettled, locationSettled, visualSettled] =
      await Promise.allSettled([
        spawnAndAwaitChild<CharacterBibleWorkflowInput, CharacterMinimal[]>(
          step,
          {
            binding: characterBibleBinding as Workflow<
              CharacterBibleWorkflowInput & {
                _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
              }
            >,
            parentBindingName: PARENT_BINDING_NAME,
            parentInstanceId,
            childId: `character-bible:${sequenceId ?? 'no-seq'}`,
            childPayload: {
              sequenceId,
              userId: input.userId,
              teamId: input.teamId,
              characterBible,
              talentMatches: talentCharacterMatches,
              imageModel,
              styleConfig,
            },
            spawnStepName: 'spawn-character-bible',
            awaitStepName: 'await-character-bible',
          }
        ),
        spawnAndAwaitChild<
          LocationBibleWorkflowInput,
          SequenceLocationMinimal[]
        >(step, {
          binding: locationBibleBinding as Workflow<
            LocationBibleWorkflowInput & {
              _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
            }
          >,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `location-bible:${sequenceId ?? 'no-seq'}`,
          childPayload: {
            sequenceId,
            userId: input.userId,
            teamId: input.teamId,
            locationBible,
            libraryLocationMatches,
            styleConfig,
          },
          spawnStepName: 'spawn-location-bible',
          awaitStepName: 'await-location-bible',
        }),
        spawnAndAwaitChild<VisualPromptWorkflowInput, Scene[]>(step, {
          binding: visualPromptBinding as Workflow<
            VisualPromptWorkflowInput & {
              _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
            }
          >,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `visual-prompts:${sequenceId ?? 'no-seq'}`,
          childPayload: {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            scenes,
            aspectRatio,
            characterBible,
            locationBible,
            elementBible,
            styleConfig,
            analysisModelId,
            frameMapping,
          },
          spawnStepName: 'spawn-visual-prompts',
          awaitStepName: 'await-visual-prompts',
        }),
      ]);

    if (charSettled.status === 'rejected') {
      throw new Error(
        `Character sheet generation failed: ${String(charSettled.reason)}`
      );
    }
    if (locationSettled.status === 'rejected') {
      throw new Error(
        `Location sheet generation failed: ${String(locationSettled.reason)}`
      );
    }
    if (visualSettled.status === 'rejected') {
      throw new Error(
        `Visual prompt generation failed: ${String(visualSettled.reason)}`
      );
    }

    const charactersWithSheets = charSettled.value;
    const locationsWithSheets = locationSettled.value;
    const scenesWithVisualPrompts = visualSettled.value;

    // ----------------------------------------------------------------------
    // PHASE 4: frame images + motion/music prompts in parallel
    // ----------------------------------------------------------------------
    await step.do('phase-4-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 4,
        phaseName: 'Generating images…',
      });
    });

    // Build per-scene snapshots for frame-images divergence detection.
    const sceneSnapshots: FrameImageSceneSnapshot[] =
      scenesWithVisualPrompts.map((scene) => {
        const characters = matchCharactersToScene(
          charactersWithSheets,
          scene.continuity?.characterTags ?? []
        );
        const locations = matchLocationsToScene(
          locationsWithSheets,
          scene.continuity?.environmentTag ?? '',
          scene.metadata?.location ?? ''
        );
        const elementsMatched = matchElementsToScene(
          elementsMinimal,
          scene.continuity?.elementTags ?? [],
          scene.originalScript.extract
        );
        return {
          sceneId: scene.sceneId,
          visualPrompt: scene.prompts?.visual?.fullPrompt ?? '',
          characterSheetHashes: characters
            .map((c) => c.sheetInputHash)
            .filter((h): h is string => typeof h === 'string')
            .sort(),
          locationSheetHashes: locations
            .map((l) => l.referenceInputHash)
            .filter((h): h is string => typeof h === 'string')
            .sort(),
          elementReferenceHashes: elementsMatched
            .map((e) => e.imageUrl)
            .filter((u) => u.length > 0)
            .sort(),
        };
      });

    const frameImagesPayload: FrameImagesWorkflowInput = {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId,
      scenesWithVisualPrompts,
      charactersWithSheets,
      locationsWithSheets,
      elements: elementsMinimal,
      frameMapping,
      imageModel,
      imageModels,
      aspectRatio,
      sceneSnapshots,
    };
    frameImagesPayload.snapshotInputHash = await computeFrameImagesHashFromDto({
      ...frameImagesPayload,
      sceneSnapshots,
    });

    const frameImagesBinding = this.env.FRAME_IMAGES_WORKFLOW;
    if (!frameImagesBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] FRAME_IMAGES_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }
    const motionMusicBinding = this.env.MOTION_MUSIC_PROMPTS_WORKFLOW;
    if (!motionMusicBinding) {
      throw new NonRetryableError(
        '[AnalyzeScriptWorkflow:cf] MOTION_MUSIC_PROMPTS_WORKFLOW binding missing on env; check wrangler.jsonc',
        'WorkflowValidationError'
      );
    }

    const [frameImagesSettled, motionMusicSettled] = await Promise.allSettled([
      spawnAndAwaitChild<FrameImagesWorkflowInput, FrameImagesWorkflowResult>(
        step,
        {
          binding: frameImagesBinding as Workflow<
            FrameImagesWorkflowInput & {
              _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
            }
          >,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `frame-images:${sequenceId ?? 'no-seq'}`,
          childPayload: frameImagesPayload,
          spawnStepName: 'spawn-frame-images',
          awaitStepName: 'await-frame-images',
        }
      ),
      spawnAndAwaitChild<
        MotionMusicPromptsWorkflowInput,
        MotionMusicPromptsWorkflowResult
      >(step, {
        binding: motionMusicBinding as Workflow<
          MotionMusicPromptsWorkflowInput & {
            _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
          }
        >,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `motion-music-prompts:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          scenesWithVisualPrompts,
          frameMapping,
          aspectRatio,
          characterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          videoModel,
        },
        spawnStepName: 'spawn-motion-music-prompts',
        awaitStepName: 'await-motion-music-prompts',
      }),
    ]);

    // Record analysis duration before raising failures (mirrors QStash).
    await step.do('record-analysis-duration', async () => {
      if (sequenceId) {
        await scopedDb.sequences.updateAnalysisDurationMs(
          sequenceId,
          Date.now() - startTime
        );
      }
    });

    if (frameImagesSettled.status === 'rejected') {
      throw new Error(
        `Frame image generation failed: ${String(frameImagesSettled.reason)}`
      );
    }
    if (motionMusicSettled.status === 'rejected') {
      throw new Error(
        `Motion/music prompt generation failed: ${String(motionMusicSettled.reason)}`
      );
    }

    const imageUrls = frameImagesSettled.value.imageUrls;
    const { completeScenes, musicPrompt, musicTags } = motionMusicSettled.value;

    // ----------------------------------------------------------------------
    // PHASE 5: motion (+ optional music + merge) batch — single child
    // ----------------------------------------------------------------------
    const shouldGenerateMotion =
      autoGenerateMotion && videoModel && imageUrls.length > 0;
    const shouldGenerateMusic = Boolean(
      autoGenerateMusic &&
      sequenceId &&
      completeScenes.some(
        (s) => s.musicDesign?.presence && s.musicDesign.presence !== 'none'
      )
    );

    if (shouldGenerateMotion) {
      let totalDuration = 0;
      for (const scene of completeScenes) {
        totalDuration += scene.metadata?.durationSeconds || 5;
      }

      const batchFrames = completeScenes.map((scene, index) => {
        const motionPromptData = scene.prompts?.motion;
        if (!motionPromptData?.fullPrompt) {
          throw new WorkflowValidationError(
            `Scene ${scene.sceneId} has no motion prompt`
          );
        }

        const imageUrl = imageUrls[index];
        if (!imageUrl) {
          throw new WorkflowValidationError(
            `Scene ${scene.sceneId} has no generated image URL at index ${index}`
          );
        }

        const matchedFrame = frameMapping.find(
          (f) => f.sceneId === scene.sceneId
        );

        return {
          frameId: matchedFrame?.frameId ?? '',
          imageUrl,
          prompt: assembleMotionPrompt({
            motionPrompt: motionPromptData,
            model: videoModel,
          }),
          model: videoModel,
          duration: scene.metadata?.durationSeconds || 3,
          aspectRatio,
        };
      });

      await step.do('phase-5-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: 5,
          phaseName: shouldGenerateMusic
            ? 'Generating motion & music…'
            : 'Generating motion…',
        });
      });

      // motion-batch is NOT yet CF-ported. Build the payload for diff parity,
      // then surface a non-retryable validation error so the dispatcher falls
      // back to QStash. Once the child lands, replace with `spawnAndAwaitChild`
      // against `MOTION_BATCH_WORKFLOW`.
      await step.do('spawn-motion-batch', async () => {
        const _payload: BatchMotionMusicWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          includeMusic: shouldGenerateMusic,
          frames: batchFrames,
          music: shouldGenerateMusic
            ? {
                prompt: musicPrompt,
                tags: musicTags,
                duration: totalDuration,
                model: musicModel,
              }
            : undefined,
        };
        void _payload;
        throw new NonRetryableError(
          'Child invocation pending motion-batch port; route this workflow via QStash',
          'WorkflowValidationError'
        );
      });
    }

    if (sequenceId) {
      await step.do('record-workflow-trace', async () => {
        await recordWorkflowTrace(
          'analyzeScriptWorkflow',
          { script, styleConfig, aspectRatio },
          completeScenes,
          sequenceId,
          input.userId,
          analysisModelId,
          new Date(startTime)
        );
      });
    }

    return completeScenes;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const { sequenceId } = event.payload;
    if (!sequenceId) return;

    const sanitized = sanitizeFailResponse(error);
    console.error('[AnalyzeScriptWorkflow:cf] Failure:', sanitized);

    let userMessage = sanitized;
    if (
      isOpenRouterAuthError(sanitized) &&
      (await scopedDb.apiKeys.hasKey('openrouter'))
    ) {
      await scopedDb.apiKeys.markKeyInvalid('openrouter', sanitized);
      userMessage =
        'Your OpenRouter API key is invalid — update it in Settings.';
    }

    await scopedDb.sequence(sequenceId).updateStatus('failed', userMessage);
    await getGenerationChannel(sequenceId).emit('generation.failed', {
      message: userMessage,
    });
  }
}
