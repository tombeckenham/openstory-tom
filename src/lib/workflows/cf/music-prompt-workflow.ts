/**
 * Cloudflare Workflows port of `generateMusicPromptWorflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/music-prompt-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *
 * NOTE: the LLM step is stubbed pending Pattern 3 batch — `durableLLMCall`
 * takes an Upstash `WorkflowContext` and is not yet portable to a
 * Cloudflare `WorkflowStep`. Until that helper grows a CF code path, this
 * workflow must be routed via QStash. See
 * docs/investigations/cloudflare-workflows-poc.md.
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `music-prompt` to `'cloudflare'`.
 *
 * Class name `MusicPromptWorkflow` intentionally fixes the legacy typo in
 * the QStash export (`generateMusicPromptWorflow`).
 */

import { computeMusicPromptInputHash } from '@/lib/ai/input-hash';
import type { ScopedDb } from '@/lib/db/scoped';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export class MusicPromptWorkflow extends OpenStoryWorkflowEntrypoint<MusicPromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MusicPromptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MusicPromptWorkflowResult> {
    const input = event.payload;
    const { sceneSummaries, analysisModelId, sequenceId } = input;

    // `durableLLMCall` is the QStash-flavored LLM step from
    // `src/lib/workflows/llm-call-helper.ts`. It binds to Upstash's
    // `WorkflowContext` (uses `context.run`, observability headers, etc.)
    // and has no CF equivalent yet — porting it is the Pattern 3 batch.
    // Until then we surface a non-retryable validation error so the
    // dispatcher falls back to QStash and the instance fails fast on CF.
    const musicDesignResult: MusicPromptWorkflowResult = await step.do(
      'music-prompt-generation',
      async (): Promise<MusicPromptWorkflowResult> => {
        throw new WorkflowValidationError(
          'Child invocation pending Pattern 3 batch; route this workflow via QStash'
        );
      }
    );

    if (sequenceId) {
      if (!musicDesignResult.prompt) {
        throw new Error(
          `Music prompt generation returned empty prompt for sequence ${sequenceId}`
        );
      }

      // The variants helper appends a row tagged 'ai-generated' /
      // 'regenerated' and updates the cached `musicPrompt` / `musicTags` /
      // `musicPromptInputHash` on `sequences`. The two writes are
      // sequential, not transactional — see the helper docstring.
      const inputHash = await computeMusicPromptInputHash({
        sceneSummaries,
        analysisModel: analysisModelId,
      });

      await step.do('save-music-prompt-to-db', async () => {
        const reinforcedTags = reinforceInstrumentalTags(
          musicDesignResult.tags
        );

        const previous =
          await scopedDb.sequenceMusicPromptVariants.getLatest(sequenceId);
        const source = previous ? 'regenerated' : 'ai-generated';

        await scopedDb.sequenceMusicPromptVariants.write({
          sequenceId,
          prompt: musicDesignResult.prompt,
          tags: reinforcedTags,
          source,
          inputHash,
          analysisModel: analysisModelId,
          createdBy: input.userId,
        });
      });
    }

    return musicDesignResult;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MusicPromptWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;
    if (input.sequenceId) {
      const failSeq = scopedDb.sequence(input.sequenceId);

      await failSeq.updateMusicFields({
        musicStatus: 'failed',
        musicError: error,
      });

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.audio:progress',
          { status: 'failed' }
        );
      } catch (emitError) {
        console.error(
          `[MusicPromptWorkflow:cf] Failed to emit generation.audio:progress for sequence ${input.sequenceId}:`,
          emitError
        );
      }
    }
    console.error(
      '[MusicPromptWorkflow:cf]',
      `Music generation failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
