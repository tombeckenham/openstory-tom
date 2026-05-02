/**
 * Behavioural tests for the per-frame image-workflow snapshot helpers.
 *
 * `generateImageWorkflow` opts into the snapshot pattern so it can detect
 * drift between trigger-time and write-time and route divergent results into
 * `frame_variants`. These tests pin the two contract paths the workflow
 * branches on:
 *
 *   - convergent: live state matches the inlined snapshot → primary write
 *   - divergent: a character sheet was re-hashed mid-flight → alternate write
 */

import { describe, expect, it } from 'bun:test';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  FrameImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
} from './image-workflow-snapshot';

function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

const baseScene: FrameImageSceneSnapshot = {
  sceneId: 's1',
  visualPrompt: 'A wide establishing shot of Jack at the docks at dusk',
  characterSheetHashes: ['jack-hash-v1'],
  locationSheetHashes: ['docks-hash-v1'],
  elementReferenceHashes: [],
};

const baseInput: ImageWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq1',
  frameId: 'f1',
  prompt: baseScene.visualPrompt,
  model: 'nano_banana_2',
  aspectRatio: '16:9',
  sceneSnapshot: baseScene,
};

function buildScopedDbStub(opts: {
  characterSheetHash?: string | null;
  locationReferenceHash?: string | null;
  elementImageUrl?: string | null;
  frameMetadata?: unknown;
}) {
  return asScopedDb({
    frames: {
      getById: async () => ({
        id: 'f1',
        metadata: opts.frameMetadata ?? {
          sceneId: 's1',
          continuity: {
            characterTags: ['jack'],
            environmentTag: 'docks',
            elementTags: [],
          },
          metadata: { location: 'Docks' },
          originalScript: { extract: '' },
        },
      }),
    },
    characters: {
      listWithSheets: async () =>
        opts.characterSheetHash === undefined
          ? []
          : [
              {
                id: 'c1',
                sequenceId: 'seq1',
                characterId: 'jack',
                consistencyTag: 'jack',
                name: 'Jack',
                sheetImageUrl: 'https://example.com/jack.png',
                sheetInputHash: opts.characterSheetHash,
              },
            ],
    },
    sequenceLocations: {
      listWithReferences: async () =>
        opts.locationReferenceHash === undefined
          ? []
          : [
              {
                id: 'l1',
                sequenceId: 'seq1',
                locationId: 'docks',
                consistencyTag: 'docks',
                name: 'Docks',
                referenceImageUrl: 'https://example.com/docks.png',
                referenceInputHash: opts.locationReferenceHash,
              },
            ],
    },
    sequenceElements: {
      list: async () =>
        opts.elementImageUrl === undefined
          ? []
          : [
              {
                id: 'e1',
                token: 'LOGO',
                description: null,
                consistencyTag: 'logo',
                imageUrl: opts.elementImageUrl,
              },
            ],
    },
  });
}

describe('computeImageWorkflowHashFromDto', () => {
  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const result = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: undefined,
      snapshotInputHash: undefined,
    });
    expect(result).toBe('');
  });

  it('produces a deterministic hash for identical snapshots', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto(baseInput);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes the hash when the model changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      model: 'seedream_v5',
    });
    expect(a).not.toBe(b);
  });

  it('changes the hash when a character sheet hash changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        characterSheetHashes: ['jack-hash-v2'],
      },
    });
    expect(a).not.toBe(b);
  });
});

describe('computeImageWorkflowHashCurrent', () => {
  it('matches the DTO hash on the convergent path (live state == snapshot)', async () => {
    const dtoHash = await computeImageWorkflowHashFromDto(baseInput);
    const currentHash = await computeImageWorkflowHashCurrent(
      baseInput,
      buildScopedDbStub({
        characterSheetHash: 'jack-hash-v1',
        locationReferenceHash: 'docks-hash-v1',
      })
    );
    expect(currentHash).toBe(dtoHash);
  });

  it('diverges from the DTO hash when a character sheet was re-hashed mid-flight', async () => {
    const dtoHash = await computeImageWorkflowHashFromDto(baseInput);
    const currentHash = await computeImageWorkflowHashCurrent(
      baseInput,
      buildScopedDbStub({
        characterSheetHash: 'jack-hash-v2',
        locationReferenceHash: 'docks-hash-v1',
      })
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('diverges when an element reference image was swapped', async () => {
    const inputWithElement: ImageWorkflowInput = {
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        elementReferenceHashes: ['https://example.com/logo-v1.png'],
      },
    };
    const stub = buildScopedDbStub({
      characterSheetHash: 'jack-hash-v1',
      locationReferenceHash: 'docks-hash-v1',
      elementImageUrl: 'https://example.com/logo-v2.png',
      frameMetadata: {
        sceneId: 's1',
        continuity: {
          characterTags: ['jack'],
          environmentTag: 'docks',
          elementTags: ['LOGO'],
        },
        metadata: { location: 'Docks' },
        originalScript: { extract: 'see LOGO at the door' },
      },
    });
    const dtoHash = await computeImageWorkflowHashFromDto(inputWithElement);
    const currentHash = await computeImageWorkflowHashCurrent(
      inputWithElement,
      stub
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const stub = asScopedDb({});
    const result = await computeImageWorkflowHashCurrent(
      { ...baseInput, sceneSnapshot: undefined, snapshotInputHash: undefined },
      stub
    );
    expect(result).toBe('');
  });
});
