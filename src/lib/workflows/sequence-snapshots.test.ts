/**
 * Behavioural tests for the sequence-level video snapshot helpers.
 *
 * `mergeVideoWorkflow` opts into the snapshot pattern so it can detect drift
 * between trigger-time and write-time and route divergent results into
 * `sequence_video_variants`. These tests pin the two contract paths the
 * workflow branches on:
 *
 *   - convergent: live frame video hashes match the inlined snapshot
 *   - divergent: a frame's video was re-rendered (new `videoInputHash`)
 *     between trigger and write
 */

import { describe, expect, it } from 'bun:test';
import type { Frame } from '@/lib/db/schema';
import type { MergeVideoWorkflowInput } from '@/lib/workflow/types';
import {
  buildMergeVideoSourcesFromFrames,
  computeSequenceVideoHashCurrent,
  computeSequenceVideoHashFromDto,
  type SequenceVideoHashScopedDb,
} from './sequence-snapshots';

type FrameStub = Pick<Frame, 'orderIndex' | 'videoUrl' | 'videoInputHash'>;

const F1_URL = 'https://example.com/f1.mp4';
const F2_URL = 'https://example.com/f2.mp4';
const F1_HASH = 'frame-1-hash-v1';
const F2_HASH = 'frame-2-hash-v1';

const F1: FrameStub = {
  orderIndex: 0,
  videoUrl: F1_URL,
  videoInputHash: F1_HASH,
};
const F2: FrameStub = {
  orderIndex: 1,
  videoUrl: F2_URL,
  videoInputHash: F2_HASH,
};

const baseInput: MergeVideoWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq1',
  videoUrls: [F1_URL, F2_URL],
  sourceFrameVideoHashes: [
    { kind: 'variantHash', hash: F1_HASH },
    { kind: 'variantHash', hash: F2_HASH },
  ],
  targetFps: 24,
  resolution: { width: 1920, height: 1080 },
};

function stubScopedDb(frames: FrameStub[]): SequenceVideoHashScopedDb {
  return {
    frames: {
      listBySequence: async () => frames,
    },
  };
}

describe('buildMergeVideoSourcesFromFrames', () => {
  it('produces parallel videoUrls and variantHash sources for frames with hashes', () => {
    const result = buildMergeVideoSourcesFromFrames([F1, F2]);
    expect(result.videoUrls).toEqual([F1_URL, F2_URL]);
    expect(result.sourceFrameVideoHashes).toEqual([
      { kind: 'variantHash', hash: F1_HASH },
      { kind: 'variantHash', hash: F2_HASH },
    ]);
  });

  it('falls back to kind:url for frames without a videoInputHash', () => {
    const legacy: FrameStub = {
      orderIndex: 0,
      videoUrl: 'https://example.com/legacy.mp4',
      videoInputHash: null,
    };
    const result = buildMergeVideoSourcesFromFrames([legacy]);
    expect(result.sourceFrameVideoHashes).toEqual([
      { kind: 'url', url: 'https://example.com/legacy.mp4' },
    ]);
  });

  it('skips frames with no videoUrl', () => {
    const noVideo: FrameStub = {
      orderIndex: 0,
      videoUrl: null,
      videoInputHash: null,
    };
    const result = buildMergeVideoSourcesFromFrames([noVideo, F1]);
    expect(result.videoUrls).toEqual([F1_URL]);
    expect(result.sourceFrameVideoHashes).toHaveLength(1);
  });
});

describe('computeSequenceVideoHashFromDto', () => {
  it('produces a deterministic hash for identical input', async () => {
    const a = await computeSequenceVideoHashFromDto(baseInput);
    const b = await computeSequenceVideoHashFromDto(baseInput);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes when a frame video hash changes', async () => {
    const a = await computeSequenceVideoHashFromDto(baseInput);
    const b = await computeSequenceVideoHashFromDto({
      ...baseInput,
      sourceFrameVideoHashes: [
        { kind: 'variantHash', hash: 'frame-1-hash-v2' },
        { kind: 'variantHash', hash: F2_HASH },
      ],
    });
    expect(a).not.toBe(b);
  });

  it('changes when source order changes (sources are ordered)', async () => {
    const a = await computeSequenceVideoHashFromDto(baseInput);
    const reversed = await computeSequenceVideoHashFromDto({
      ...baseInput,
      videoUrls: [F2_URL, F1_URL],
      sourceFrameVideoHashes: [
        { kind: 'variantHash', hash: F2_HASH },
        { kind: 'variantHash', hash: F1_HASH },
      ],
    });
    expect(a).not.toBe(reversed);
  });

  it('changes when targetFps or resolution changes', async () => {
    const a = await computeSequenceVideoHashFromDto(baseInput);
    const b = await computeSequenceVideoHashFromDto({
      ...baseInput,
      targetFps: 30,
    });
    const c = await computeSequenceVideoHashFromDto({
      ...baseInput,
      resolution: { width: 1280, height: 720 },
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('falls back to kind:url sources when sourceFrameVideoHashes is omitted (legacy payload)', async () => {
    const legacyInput: MergeVideoWorkflowInput = {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq1',
      videoUrls: [F1_URL],
    };
    // The legacy input must be deterministic and equal to an explicit
    // url-source payload for the same URL, so reruns of an existing chain
    // remain idempotent.
    const legacyHash = await computeSequenceVideoHashFromDto(legacyInput);
    const explicitUrlHash = await computeSequenceVideoHashFromDto({
      ...legacyInput,
      sourceFrameVideoHashes: [{ kind: 'url', url: F1_URL }],
    });
    expect(legacyHash).toBe(explicitUrlHash);
  });
});

describe('computeSequenceVideoHashCurrent', () => {
  it('matches the DTO hash on the convergent path (live frames match snapshot)', async () => {
    const dtoHash = await computeSequenceVideoHashFromDto(baseInput);
    const currentHash = await computeSequenceVideoHashCurrent(
      baseInput,
      stubScopedDb([F1, F2])
    );
    expect(currentHash).toBe(dtoHash);
  });

  it('diverges from the DTO hash when a frame video was re-rendered mid-flight', async () => {
    const dtoHash = await computeSequenceVideoHashFromDto(baseInput);
    const currentHash = await computeSequenceVideoHashCurrent(
      baseInput,
      stubScopedDb([{ ...F1, videoInputHash: 'frame-1-hash-v2' }, F2])
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('falls back to kind:url when a frame has no videoInputHash (legacy data)', async () => {
    const legacyF1: FrameStub = { ...F1, videoInputHash: null };
    const legacyInput: MergeVideoWorkflowInput = {
      ...baseInput,
      sourceFrameVideoHashes: [
        { kind: 'url', url: F1_URL },
        { kind: 'variantHash', hash: F2_HASH },
      ],
    };
    const dtoHash = await computeSequenceVideoHashFromDto(legacyInput);
    const currentHash = await computeSequenceVideoHashCurrent(
      legacyInput,
      stubScopedDb([legacyF1, F2])
    );
    expect(currentHash).toBe(dtoHash);
  });

  it('throws when a videoUrl no longer maps to any frame (deleted mid-flight)', () => {
    // Only F2 remains; F1 was deleted. Falling back to kind:url here would
    // silently match the trigger-time hash for legacy frames and route a
    // stale merge onto the primary slot. Throwing forces the workflow to
    // fail loudly on a raced delete rather than corrupt the primary.
    return expect(
      computeSequenceVideoHashCurrent(baseInput, stubScopedDb([F2]))
    ).rejects.toThrow(/not found in sequence/);
  });

  it('returns the FromDto hash when sequenceId is omitted (no DB context)', async () => {
    const anonymousInput: MergeVideoWorkflowInput = {
      ...baseInput,
      sequenceId: undefined,
    };
    const dtoHash = await computeSequenceVideoHashFromDto(anonymousInput);
    const currentHash = await computeSequenceVideoHashCurrent(
      anonymousInput,
      // listBySequence should not be called in this branch
      {
        frames: {
          listBySequence: async () => {
            throw new Error('listBySequence should not be called');
          },
        },
      }
    );
    expect(currentHash).toBe(dtoHash);
  });
});
