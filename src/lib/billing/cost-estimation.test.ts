import { describe, expect, it } from 'vitest';
import type { TextToImageModel, ImageToVideoModel } from '@/lib/ai/models';
import {
  estimateImageCost,
  estimateStoryboardCost,
  estimateVideoCost,
} from './cost-estimation';

const IMAGE_MODEL: TextToImageModel = 'nano_banana_2';
const VIDEO_A: ImageToVideoModel = 'kling_v3_pro';
const VIDEO_B: ImageToVideoModel = 'veo3_1';
const SCENE_COUNT = 8;
const DURATION = 5;

const base = {
  imageModel: IMAGE_MODEL,
  aspectRatio: '16:9' as const,
  estimatedSceneCount: SCENE_COUNT,
};

/** Per-frame motion cost a model contributes across the whole storyboard. */
const motionContribution = (model: ImageToVideoModel) =>
  Number(estimateVideoCost(model, DURATION)) * SCENE_COUNT;

describe('estimateStoryboardCost', () => {
  it('adds exactly one extra per-frame image pass per image model', () => {
    const one = Number(estimateStoryboardCost({ ...base, imageModelCount: 1 }));
    const two = Number(estimateStoryboardCost({ ...base, imageModelCount: 2 }));
    // Only per-frame images scale with model count — the character/location
    // sheets and LLM analysis are charged once regardless.
    const perFrameImagePass = Number(
      estimateImageCost(IMAGE_MODEL, base.aspectRatio, SCENE_COUNT)
    );
    expect(two - one).toBe(perFrameImagePass);
  });

  it('sums each selected video model’s own per-frame motion cost', () => {
    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    const oneModel = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A],
      })
    );
    const twoModels = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A, VIDEO_B],
      })
    );

    expect(oneModel - noMotion).toBe(motionContribution(VIDEO_A));
    expect(twoModels - noMotion).toBe(
      motionContribution(VIDEO_A) + motionContribution(VIDEO_B)
    );
  });

  it('prices a mixed selection per model, not as a flat multiple of the primary', () => {
    // Guards the regression where N models were charged at N× the primary's
    // rate. These two models have genuinely different parameter-based pricing,
    // so the true sum diverges from the flat-multiplier estimate.
    expect(motionContribution(VIDEO_A)).not.toBe(motionContribution(VIDEO_B));

    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    const mixed = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A, VIDEO_B],
      })
    );

    const trueSum = motionContribution(VIDEO_A) + motionContribution(VIDEO_B);
    const flatMultiplierEstimate = motionContribution(VIDEO_A) * 2;
    expect(mixed - noMotion).toBe(trueSum);
    expect(mixed - noMotion).not.toBe(flatMultiplierEstimate);
  });

  it('adds no motion cost when motion is off or no models are selected', () => {
    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    // autoGenerateMotion true but no models / empty list → nothing to bill.
    expect(
      Number(estimateStoryboardCost({ ...base, autoGenerateMotion: true }))
    ).toBe(noMotion);
    expect(
      Number(
        estimateStoryboardCost({
          ...base,
          autoGenerateMotion: true,
          videoModels: [],
        })
      )
    ).toBe(noMotion);
    // Models present but motion disabled → still no motion cost.
    expect(
      Number(
        estimateStoryboardCost({
          ...base,
          autoGenerateMotion: false,
          videoModels: [VIDEO_A, VIDEO_B],
        })
      )
    ).toBe(noMotion);
  });
});
