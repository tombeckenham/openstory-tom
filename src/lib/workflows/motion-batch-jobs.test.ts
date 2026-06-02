import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL, type ImageToVideoModel } from '@/lib/ai/models';
import { buildMotionJobs } from './motion-batch-jobs';

type Frame = { frameId: string; model?: ImageToVideoModel };

const A: ImageToVideoModel = 'kling_v3_pro';
const B: ImageToVideoModel = 'veo3_1';

const frames: Frame[] = [
  { frameId: 'f0' },
  { frameId: 'f1' },
  { frameId: 'f2' },
];

describe('buildMotionJobs', () => {
  it('expands each frame across every top-level video model (N×M jobs)', () => {
    const jobs = buildMotionJobs(frames, [A, B]);
    expect(jobs.length).toBe(frames.length * 2);
    // Frames keep their order; each frame gets one job per model.
    expect(jobs.map((j) => [j.frameIndex, j.model])).toEqual([
      [0, A],
      [0, B],
      [1, A],
      [1, B],
      [2, A],
      [2, B],
    ]);
    // The original frame object is carried through unchanged.
    expect(jobs[0]?.frame).toBe(frames[0]);
  });

  it('dedupes the top-level model list so a model is never billed twice per frame', () => {
    const oneFrame: Frame[] = [{ frameId: 'f0' }];
    const jobs = buildMotionJobs(oneFrame, [A, A, B, A]);
    expect(jobs.map((j) => j.model)).toEqual([A, B]);
  });

  it('keeps each (frameIndex, model) pair unique so child instance ids never collide', () => {
    const jobs = buildMotionJobs(frames, [A, B, A]);
    const keys = jobs.map((j) => `${j.frameIndex}:${j.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('falls back to each frame’s own model when no top-level models are given', () => {
    const perFrame: Frame[] = [
      { frameId: 'f0', model: A },
      { frameId: 'f1', model: B },
    ];
    expect(buildMotionJobs(perFrame, undefined).map((j) => j.model)).toEqual([
      A,
      B,
    ]);
    // An empty list is treated the same as absent (single-model fallback).
    expect(buildMotionJobs(perFrame, []).map((j) => j.model)).toEqual([A, B]);
  });

  it('falls back to DEFAULT_VIDEO_MODEL when a frame has no model and none are given', () => {
    const oneFrame: Frame[] = [{ frameId: 'f0' }];
    const jobs = buildMotionJobs(oneFrame, undefined);
    expect(jobs.map((j) => j.model)).toEqual([DEFAULT_VIDEO_MODEL]);
  });

  it('top-level models win over per-frame model', () => {
    const perFrame: Frame[] = [{ frameId: 'f0', model: A }];
    expect(buildMotionJobs(perFrame, [B]).map((j) => j.model)).toEqual([B]);
  });

  it('returns no jobs for no frames', () => {
    expect(buildMotionJobs([], [A, B])).toEqual([]);
  });
});
