import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { describe, expect, it } from 'vitest';
import { buildFrameReorder, type FrameReorderInput } from './reorder-frames';

const scene = (sceneNumber: number): Scene => ({
  sceneId: `scene-${sceneNumber}`,
  sceneNumber,
  originalScript: { extract: '', dialogue: [] },
  metadata: {
    title: `Scene ${sceneNumber}`,
    durationSeconds: 3,
    location: 'INT. ROOM',
    timeOfDay: 'DAY',
    storyBeat: 'beat',
  },
});

const frame = (id: string, sceneNumber: number | null): FrameReorderInput => ({
  id,
  metadata: sceneNumber === null ? null : scene(sceneNumber),
});

describe('buildFrameReorder', () => {
  it('assigns sequential orderIndex matching the requested order', () => {
    const frames = [frame('a', 1), frame('b', 2), frame('c', 3)];
    const updates = buildFrameReorder(frames, ['c', 'a', 'b']);

    expect(updates.map((u) => [u.id, u.orderIndex])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('renumbers metadata.sceneNumber to match the new position', () => {
    const frames = [frame('a', 1), frame('b', 2), frame('c', 3)];
    const updates = buildFrameReorder(frames, ['c', 'a', 'b']);

    expect(updates.map((u) => u.metadata?.sceneNumber)).toEqual([1, 2, 3]);
  });

  it('preserves other metadata fields while renumbering', () => {
    const frames = [frame('a', 1), frame('b', 2)];
    const updates = buildFrameReorder(frames, ['b', 'a']);

    expect(updates[0]?.metadata?.metadata?.title).toBe('Scene 2');
    expect(updates[0]?.metadata?.sceneNumber).toBe(1);
  });

  it('leaves null metadata as null', () => {
    const frames = [frame('a', null), frame('b', 2)];
    const updates = buildFrameReorder(frames, ['b', 'a']);

    const a = updates.find((u) => u.id === 'a');
    expect(a?.metadata).toBeNull();
    expect(a?.orderIndex).toBe(1);
  });

  it('throws when an id does not belong to the sequence', () => {
    const frames = [frame('a', 1), frame('b', 2)];
    expect(() => buildFrameReorder(frames, ['a', 'zzz'])).toThrow(
      /does not belong/
    );
  });

  it('throws when the set is incomplete', () => {
    const frames = [frame('a', 1), frame('b', 2), frame('c', 3)];
    expect(() => buildFrameReorder(frames, ['a', 'b'])).toThrow(
      /every frame exactly once/
    );
  });

  it('throws on duplicate ids', () => {
    const frames = [frame('a', 1), frame('b', 2)];
    expect(() => buildFrameReorder(frames, ['a', 'a'])).toThrow(/Duplicate/);
  });
});
