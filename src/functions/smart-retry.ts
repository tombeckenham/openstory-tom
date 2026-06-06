/**
 * Smart Retry Server Function
 * Detects what failed in a sequence and only retries those parts.
 * Falls back to full storyboard retry when prompts are missing.
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  estimateImageCost,
  estimateStoryboardCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import { addMicros, multiplyMicros, ZERO_MICROS } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { Character } from '@/lib/db/schema';
import { analyzeFailures } from '@/lib/failures/failure-analysis';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import {
  assertNoActiveStoryboard,
  triggerStoryboard,
} from '@/lib/workflow/launchers';
import type {
  ImageWorkflowInput,
  MotionWorkflowInput,
  MusicWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';
import { buildSceneSummaries } from './sequences';

function getSceneCharacterReferenceImages(
  allCharacters: Character[],
  characterTags: string[]
) {
  if (characterTags.length === 0) return [];

  const matchedCharacters = allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();

    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        tagLower.includes(charName) ||
        tagLower.includes(char.characterId.toLowerCase())
      );
    });
  });

  return buildCharacterReferenceImages(matchedCharacters);
}

export const smartRetryFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const { sequence, user, teamId } = context;

    // A sequence marked failed does NOT imply its workflow tree is dead —
    // children outlive a timed-out parent (#839). Reject every retry shape
    // (full and partial) while the last storyboard run is still in flight,
    // so we never race a live pipeline.
    await assertNoActiveStoryboard(context.scopedDb, sequence.id);

    const frames = await context.scopedDb.frames.listBySequence(sequence.id);
    const summary = analyzeFailures(frames, sequence);

    if (!summary.hasFailed) {
      throw new Error('No failures found to retry');
    }

    // Full retry fallback
    if (summary.requiresFullRetry) {
      const imageModel = safeTextToImageModel(
        sequence.imageModel,
        DEFAULT_IMAGE_MODEL
      );
      const videoModel = safeImageToVideoModel(
        sequence.videoModel,
        DEFAULT_VIDEO_MODEL
      );

      await requireCredits(
        context.scopedDb,
        estimateStoryboardCost({
          imageModel,
          aspectRatio: sequence.aspectRatio,
          videoModels: [videoModel],
        }),
        {
          providers: ['fal', 'openrouter'],
          errorMessage: 'Insufficient credits to retry storyboard',
        }
      );

      const workflowInput: StoryboardWorkflowInput = {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        options: {
          framesPerScene: 3,
          generateThumbnails: true,
          generateDescriptions: true,
          aiProvider: 'openrouter',
          regenerateAll: true,
        },
      };

      // Owns the generation mutex, the 'processing' status write, and the
      // run-id persistence (#839).
      await triggerStoryboard(context.scopedDb, workflowInput);

      return { retryType: 'full' as const, retriedItems: ['full storyboard'] };
    }

    // Smart retry: only retry failed parts
    const retried: string[] = [];
    let totalCost = ZERO_MICROS;

    const imageModel = safeTextToImageModel(
      sequence.imageModel,
      DEFAULT_IMAGE_MODEL
    );
    const videoModel = safeImageToVideoModel(
      sequence.videoModel,
      DEFAULT_VIDEO_MODEL
    );

    // Collect failed items and estimate costs
    const failedImageFrames = frames.filter(
      (f) => f.thumbnailStatus === 'failed'
    );
    const failedMotionFrames = frames.filter(
      (f) => f.videoStatus === 'failed' && f.thumbnailUrl && f.motionPrompt
    );
    const hasMusicFailure =
      sequence.musicStatus === 'failed' && sequence.musicPrompt;

    // Calculate total cost
    if (failedImageFrames.length > 0) {
      totalCost = addMicros(
        totalCost,
        estimateImageCost(
          imageModel,
          sequence.aspectRatio,
          failedImageFrames.length
        )
      );
    }

    if (failedMotionFrames.length > 0) {
      const { snapDuration } = await import('@/lib/motion/motion-generation');
      const duration = snapDuration(undefined, videoModel);
      totalCost = addMicros(
        totalCost,
        multiplyMicros(
          estimateVideoCost(videoModel, duration),
          failedMotionFrames.length
        )
      );
    }

    // Single credit check for all retries
    if (totalCost > 0) {
      await requireCredits(context.scopedDb, totalCost, {
        providers: ['fal'],
        errorMessage: 'Insufficient credits to retry failed items',
      });
    }

    // 1. Retry failed images
    if (failedImageFrames.length > 0) {
      const allCharacters = await context.scopedDb.characters.listWithSheets(
        sequence.id
      );

      for (const frame of failedImageFrames) {
        const prompt =
          frame.imagePrompt ||
          frame.metadata?.prompts?.visual?.fullPrompt ||
          frame.description;

        if (!prompt) continue;

        const characterTags = frame.metadata?.continuity?.characterTags ?? [];
        const referenceImages = getSceneCharacterReferenceImages(
          allCharacters,
          characterTags
        );

        const workflowInput: ImageWorkflowInput = {
          userId: user.id,
          teamId,
          prompt,
          model: imageModel,
          imageSize: aspectRatioToImageSize(sequence.aspectRatio),
          numImages: 1,
          frameId: frame.id,
          sequenceId: sequence.id,
          referenceImages,
        };

        await triggerWorkflow('/image', workflowInput, {
          label: buildWorkflowLabel(sequence.id),
        });
      }

      retried.push(`${failedImageFrames.length} image(s)`);
    }

    // 2. Retry failed motion
    if (failedMotionFrames.length > 0) {
      for (const frame of failedMotionFrames) {
        if (!frame.thumbnailUrl) continue;

        const workflowInput: MotionWorkflowInput = {
          userId: user.id,
          teamId,
          frameId: frame.id,
          sequenceId: sequence.id,
          imageUrl: frame.thumbnailUrl,
          prompt: resolveMotionPrompt(frame, videoModel),
          model: videoModel,
          aspectRatio: sequence.aspectRatio,
          duration: frame.durationMs ? frame.durationMs / 1000 : undefined,
        };

        await triggerWorkflow('/motion', workflowInput, {
          label: buildWorkflowLabel(sequence.id),
        });
      }

      retried.push(`${failedMotionFrames.length} motion video(s)`);
    }

    // 3. Retry failed music
    if (hasMusicFailure && sequence.musicPrompt) {
      const allFrames = await context.scopedDb.frames.listBySequence(
        sequence.id
      );
      const totalDuration = allFrames.reduce((sum, frame) => {
        const seconds = frame.durationMs
          ? frame.durationMs / 1000
          : (frame.metadata?.metadata?.durationSeconds ?? 10);
        return sum + seconds;
      }, 0);

      const musicInput: MusicWorkflowInput = {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags ?? '',
        duration: totalDuration || 30,
      };

      await context.scopedDb.sequence(sequence.id).updateMusicFields({
        musicStatus: 'generating',
        musicError: null,
      });

      await triggerWorkflow('/music', musicInput, {
        label: buildWorkflowLabel(sequence.id),
      });

      retried.push('music');
    }

    // 3b. Retry missing music prompt (use scenes fallback for LLM generation)
    if (
      !sequence.musicPrompt &&
      sequence.musicStatus !== 'completed' &&
      sequence.status === 'failed'
    ) {
      const allFrames = await context.scopedDb.frames.listBySequence(
        sequence.id
      );
      const scenes = buildSceneSummaries(allFrames);
      const totalDuration = allFrames.reduce((sum, frame) => {
        const seconds = frame.durationMs
          ? frame.durationMs / 1000
          : (frame.metadata?.metadata?.durationSeconds ?? 10);
        return sum + seconds;
      }, 0);

      // Generate music prompt
      await triggerWorkflow(
        '/music-prompt',
        {
          userId: user.id,
          teamId,
          sequenceId: sequence.id,
          sceneSummaries: scenes,
          analysisModelId: sequence.analysisModel,
          duration: totalDuration || 30,
        },
        { label: buildWorkflowLabel(sequence.id) }
      );

      retried.push('music prompt');
    }

    // Reset sequence status from 'failed' back to 'completed'
    if (sequence.status === 'failed') {
      await context.scopedDb.sequence(sequence.id).updateStatus('completed');
    }

    return { retryType: 'smart' as const, retriedItems: retried };
  });
