/**
 * Content-flag retry E2E (#881)
 *
 * Proves the bounded same-model retry rescues a content-filter rejection on
 * both the image and motion paths. aimock returns a 422 content-checker
 * rejection on the FIRST generation attempt and a success on the retry
 * (curated fixtures in `e2e/fixtures/recorded/fal/_content-retry/`, keyed on
 * model + sequenceIndex). The frame's thumbnail AND a motion clip's video must
 * end `completed` — if the retry didn't fire, the first-attempt rejection would
 * leave them `failed`.
 *
 * Decoupled from the full script→frames pipeline: it seeds a sequence + frame
 * directly and triggers ImageWorkflow / MotionWorkflow via the test-only
 * `/api/test/generate` route with a controlled prompt + model. Uses two models
 * (`seedream_v5`, `ltx_2_3_pro`) that no other spec exercises, so the
 * sequential fixtures never interfere with other runs.
 *
 * Gated behind `PLAYWRIGHT_CONTENT_RETRY=true` — run via
 * `bun test:e2e:content-retry`.
 */

import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import {
  cleanupSequenceById,
  createTestFrame,
  createTestSequence,
  getTestSequenceFrames,
  triggerTestGeneration,
} from '../fixtures/sequence.fixture';

const contentRetry = process.env.PLAYWRIGHT_CONTENT_RETRY === 'true';

testWithUser.describe('Content-flag retry (#881)', () => {
  testWithUser.skip(
    !contentRetry,
    'Set PLAYWRIGHT_CONTENT_RETRY=true (use `bun test:e2e:content-retry`) to run.'
  );

  // Each path makes a couple of fal round-trips (reject → reseeded retry) plus
  // an R2 upload of the success asset.
  testWithUser.setTimeout(240_000);

  testWithUser(
    'image and motion recover from a first-attempt content-flag rejection',
    async ({ testUser }) => {
      const sequence = await createTestSequence(
        testUser.teamId,
        testUser.id,
        'Content-retry e2e'
      );
      const frame = await createTestFrame(sequence.id, 0);

      // ── Image path ──────────────────────────────────────────────────────
      // Attempt 0 is rejected by the content checker; attempt 1 (reseeded,
      // SAME model) succeeds. thumbnailStatus must end 'completed'.
      await triggerTestGeneration({
        kind: 'image',
        userId: testUser.id,
        teamId: testUser.teamId,
        sequenceId: sequence.id,
        frameId: frame.id,
        prompt: 'A calm sunlit studio, wide establishing shot',
        imageModel: 'seedream_v5',
      });

      await expect
        .poll(
          async () => {
            const [f] = await getTestSequenceFrames(sequence.id);
            return f?.thumbnailStatus;
          },
          {
            timeout: 120_000,
            intervals: [1_000, 2_000, 5_000],
            message: 'frame thumbnail completes after the image retry',
          }
        )
        .toBe('completed');

      const [afterImage] = await getTestSequenceFrames(sequence.id);
      expect(
        afterImage?.thumbnailUrl,
        'frame thumbnail url set after retry'
      ).toBeTruthy();
      const startImageUrl = afterImage?.thumbnailUrl;
      if (!startImageUrl) throw new Error('seeded frame has no thumbnail url');

      // ── Motion path ─────────────────────────────────────────────────────
      // Same pattern on the video path; the seeded frame image is the start
      // frame. videoStatus must end 'completed' with a url.
      await triggerTestGeneration({
        kind: 'motion',
        userId: testUser.id,
        teamId: testUser.teamId,
        sequenceId: sequence.id,
        frameId: frame.id,
        prompt: 'Slow push in on the studio',
        videoModel: 'ltx_2_3_pro',
        imageUrl: startImageUrl,
      });

      await expect
        .poll(
          async () => {
            const [f] = await getTestSequenceFrames(sequence.id);
            return f?.videoStatus;
          },
          {
            timeout: 180_000,
            intervals: [2_000, 5_000],
            message: 'frame video completes after the motion retry',
          }
        )
        .toBe('completed');

      const [afterMotion] = await getTestSequenceFrames(sequence.id);
      expect(
        afterMotion?.videoUrl,
        'frame video url set after retry'
      ).toBeTruthy();

      await cleanupSequenceById(sequence.id, sequence.styleId);
    }
  );
});
