import { generateMockStyles } from '@/lib/mocks/data-generators';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { StyleSelector } from './style-selector';

const meta = {
  title: 'Style/StyleSelector',
  component: StyleSelector,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof StyleSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockStyles = generateMockStyles(15);
const firstMockStyle = mockStyles[0];
if (!firstMockStyle) throw new Error('story setup: expected mock styles');

export const Default: Story = {
  args: {
    styles: mockStyles,
    selectedStyleId: firstMockStyle.id,
    onStyleSelect: fn(),
  },
  render: function RenderDefault() {
    const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
      firstMockStyle.id
    );

    return (
      <StyleSelector
        styles={mockStyles}
        selectedStyleId={selectedStyleId}
        onStyleSelect={setSelectedStyleId}
      />
    );
  },
};
