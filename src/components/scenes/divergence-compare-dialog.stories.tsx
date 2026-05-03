import type { Meta, StoryObj } from '@storybook/react';
import type { Frame, FrameVariant } from '@/lib/db/schema';
import { DivergenceCompareDialog } from './divergence-compare-dialog';

const baseFrame = {
  id: 'frame-1',
  sequenceId: 'seq-1',
  orderIndex: 0,
  description: 'A wide shot.',
  thumbnailUrl: 'https://images.unsplash.com/photo-1502872364588-894d7d6ddfab',
  videoUrl: null,
  audioUrl: null,
  thumbnailStatus: 'completed',
  videoStatus: 'pending',
  thumbnailInputHash: 'live-hash',
  videoInputHash: null,
  audioInputHash: null,
  variantImageInputHash: null,
} as unknown as Frame;

function makeVariant(
  overrides: Partial<FrameVariant> & {
    variantType: FrameVariant['variantType'];
  }
): FrameVariant {
  return {
    id: 'variant-1',
    frameId: 'frame-1',
    sequenceId: 'seq-1',
    model: 'nano_banana_2',
    url: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee',
    storagePath: null,
    previewUrl: null,
    shotVariantUrl: null,
    shotVariantPath: null,
    shotVariantStatus: null,
    shotVariantWorkflowRunId: null,
    status: 'completed',
    workflowRunId: null,
    generatedAt: new Date(),
    error: null,
    promptHash: null,
    inputHash: 'snapshot-hash',
    divergedAt: new Date('2026-04-29T00:00:00Z'),
    discardedAt: null,
    durationMs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const meta: Meta<typeof DivergenceCompareDialog> = {
  title: 'Scenes/DivergenceCompareDialog',
  component: DivergenceCompareDialog,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof DivergenceCompareDialog>;

export const ThumbnailVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    frame: baseFrame,
    variant: makeVariant({ variantType: 'image' }),
    onPromote: () => {},
    onDiscard: () => {},
    upstreamChanges: [
      'Character "Alex" — sheet regenerated',
      'Location "Warehouse" — recast',
    ],
  },
};

export const VideoVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    frame: {
      ...baseFrame,
      videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    } as Frame,
    variant: makeVariant({
      variantType: 'video',
      url: 'https://www.w3schools.com/html/movie.mp4',
    }),
    onPromote: () => {},
    onDiscard: () => {},
  },
};

export const AudioVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    frame: baseFrame,
    variant: makeVariant({
      variantType: 'audio',
      url: 'https://www.w3schools.com/html/horse.ogg',
    }),
    onPromote: () => {},
    onDiscard: () => {},
  },
};

export const Promoting: Story = {
  args: {
    ...ThumbnailVariant.args,
    isPromoting: true,
  } as Story['args'],
};
