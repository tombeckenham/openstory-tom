import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  IMAGE_TO_VIDEO_MODEL_KEYS,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import { triggerWorkflow } from '@/lib/workflow/client';
import type {
  ImageWorkflowInput,
  MotionWorkflowInput,
} from '@/lib/workflow/types';
import { testOnlyGuard } from './route';

/**
 * Test-only generation trigger (#881 content-flag retry e2e).
 *
 * Drives a single ImageWorkflow or MotionWorkflow for a seeded frame with a
 * caller-controlled prompt + model, returning the workflow instance id. Lets
 * the content-retry spec exercise the same-model retry path end-to-end without
 * the full script→frames pipeline (and without depending on LLM-recorded
 * prompts). Gated by `testOnlyGuard` (local host + E2E_TEST only).
 */
const GenerateSchema = z.object({
  kind: z.enum(['image', 'motion']),
  userId: z.string(),
  teamId: z.string(),
  sequenceId: z.string(),
  frameId: z.string(),
  prompt: z.string(),
  imageModel: z.string().optional(),
  videoModel: z.enum(IMAGE_TO_VIDEO_MODEL_KEYS).optional(),
  /** Start frame image for motion generation. */
  imageUrl: z.string().optional(),
});

export const Route = createFileRoute('/api/test/generate')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const data = GenerateSchema.parse(await request.json());

          if (data.kind === 'image') {
            const input: ImageWorkflowInput = {
              userId: data.userId,
              teamId: data.teamId,
              sequenceId: data.sequenceId,
              frameId: data.frameId,
              prompt: data.prompt,
              model:
                data.imageModel && isValidTextToImageModel(data.imageModel)
                  ? data.imageModel
                  : undefined,
              imageSize: DEFAULT_IMAGE_SIZE,
              numImages: 1,
            };
            const workflowRunId = await triggerWorkflow('/image', input);
            return Response.json({ workflowRunId });
          }

          if (!data.imageUrl) {
            return Response.json(
              { error: 'imageUrl is required for motion generation' },
              { status: 400 }
            );
          }

          const input: MotionWorkflowInput = {
            userId: data.userId,
            teamId: data.teamId,
            sequenceId: data.sequenceId,
            frameId: data.frameId,
            imageUrl: data.imageUrl,
            prompt: data.prompt,
            model: data.videoModel,
          };
          const workflowRunId = await triggerWorkflow('/motion', input);
          return Response.json({ workflowRunId });
        },
      }),
  },
});
