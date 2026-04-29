import type { Meta, StoryObj } from '@storybook/react';
import { VideoStateOverlay } from './video-state-overlay';

const meta = {
  title: 'Motion/VideoStateOverlay',
  component: VideoStateOverlay,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="relative aspect-video w-[640px]">
        {/* Mock poster frame background */}
        <div className="absolute inset-0 bg-linear-to-br from-purple-500 to-pink-500" />
        <div className="absolute inset-0 flex items-center justify-center text-white/20 text-6xl font-bold">
          POSTER FRAME
        </div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VideoStateOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GeneratingFrame: Story = {
  args: {
    thumbnailUrl: null,
    videoStatus: 'pending',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows when the frame (thumbnail) is still being generated. Video generation will start after frame is ready.',
      },
    },
  },
};

export const HasThumbnail: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'generating',
  },
  parameters: {
    docs: {
      description: {
        story:
          'No overlay when thumbnail exists - just shows the poster image while video generates.',
      },
    },
  },
};

export const Failed: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'failed',
  },
  parameters: {
    docs: {
      description: {
        story: 'Shows error state when video generation failed.',
      },
    },
  },
};

export const Completed: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'completed',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Completed status shows no overlay (returns null). Video will play normally.',
      },
    },
  },
};
