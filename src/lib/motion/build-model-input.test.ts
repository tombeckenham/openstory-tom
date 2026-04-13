import { describe, expect, it } from 'bun:test';
import {
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  type ImageToVideoModel,
} from '../ai/models';
import { buildModelInput } from './build-model-input';
import type { GenerateMotionOptions } from './motion-generation';

const baseOptions: GenerateMotionOptions = {
  prompt: 'Camera dolly forward slowly',
  imageUrl: 'https://example.com/frame.jpg',
  duration: 5,
  aspectRatio: '16:9',
};

function build(
  modelKey: ImageToVideoModel,
  overrides: Partial<GenerateMotionOptions> = {}
): Record<string, unknown> {
  return buildModelInput(
    { ...baseOptions, ...overrides },
    IMAGE_TO_VIDEO_MODELS[modelKey],
    modelKey
  );
}

describe('buildModelInput', () => {
  describe('Kling v3 Pro (audio)', () => {
    it('uses start_image_url (not image_url)', () => {
      const result = build('kling_v3_pro');
      expect(result).toHaveProperty('start_image_url', baseOptions.imageUrl);
      expect(result).not.toHaveProperty('image_url');
    });

    it('formats duration as string', () => {
      const result = build('kling_v3_pro');
      expect(result.duration).toBe('5');
    });

    it('snaps duration to nearest supported value', () => {
      const result = build('kling_v3_pro', { duration: 7.3 });
      expect(result.duration).toBe('7');
    });

    it('applies schema defaults for cfg_scale and negative_prompt', () => {
      const result = build('kling_v3_pro');
      expect(result.cfg_scale).toBe(0.5);
      expect(result.negative_prompt).toBe('blur, distort, and low quality');
    });

    it('sets generate_audio to true from schema default', () => {
      const result = build('kling_v3_pro');
      expect(result.generate_audio).toBe(true);
    });
  });

  describe('Grok Imagine Video', () => {
    it('uses image_url', () => {
      const result = build('grok_imagine_video');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('keeps duration as integer', () => {
      const result = build('grok_imagine_video');
      expect(result.duration).toBe(5);
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('Veo 3.1 (audio)', () => {
    it('formats duration with s suffix', () => {
      const result = build('veo3_1', { duration: 8 });
      expect(result.duration).toBe('8s');
    });

    it('overrides resolution to 1080p', () => {
      const result = build('veo3_1');
      expect(result.resolution).toBe('1080p');
    });

    it('sets generate_audio to true from schema default', () => {
      const result = build('veo3_1');
      expect(result.generate_audio).toBe(true);
    });

    it('uses image_url', () => {
      const result = build('veo3_1');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });
  });

  describe('MiniMax Hailuo 02', () => {
    it('uses image_url', () => {
      const result = build('minimax_hailuo_02');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('includes prompt', () => {
      const result = build('minimax_hailuo_02');
      expect(result.prompt).toBe(baseOptions.prompt);
    });
  });

  describe('LTX 2.3 Pro', () => {
    it('uses image_url', () => {
      const result = build('ltx_2_3_pro');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('includes prompt', () => {
      const result = build('ltx_2_3_pro');
      expect(result.prompt).toBe(baseOptions.prompt);
    });

    it('snaps duration to nearest supported value (6/8/10)', () => {
      expect(build('ltx_2_3_pro', { duration: 3 }).duration).toBe('6');
      expect(build('ltx_2_3_pro', { duration: 5 }).duration).toBe('6');
      expect(build('ltx_2_3_pro', { duration: 7 }).duration).toBe('6');
      expect(build('ltx_2_3_pro', { duration: 8 }).duration).toBe('8');
      expect(build('ltx_2_3_pro', { duration: 12 }).duration).toBe('10');
    });
  });

  describe('Seedance v1.5 Pro', () => {
    it('uses image_url', () => {
      const result = build('seedance_v1_5_pro');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('includes prompt', () => {
      const result = build('seedance_v1_5_pro');
      expect(result.prompt).toBe(baseOptions.prompt);
    });
  });

  describe('common behavior', () => {
    it('always includes prompt', () => {
      for (const key of Object.keys(IMAGE_TO_VIDEO_MODELS)) {
        const result = build(safeImageToVideoModel(key));
        expect(result.prompt).toBe(baseOptions.prompt);
      }
    });

    it('passes aspect_ratio from options', () => {
      const result = build('seedance_v1_5_pro', { aspectRatio: '9:16' });
      expect(result.aspect_ratio).toBe('9:16');
    });

    it('omits aspect_ratio when not provided (API uses its own default)', () => {
      const result = build('seedance_v1_5_pro', { aspectRatio: undefined });
      expect(result.aspect_ratio).toBeUndefined();
    });
  });
});
