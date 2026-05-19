import { describe, expect, test } from 'bun:test';
import {
  buildInstanceId,
  getEnvironmentSlug,
} from '@/lib/workflow/cf/instance-id';

describe('getEnvironmentSlug', () => {
  test('returns "local" when VITE_APP_URL is unset', () => {
    expect(getEnvironmentSlug({})).toBe('local');
    expect(getEnvironmentSlug({ VITE_APP_URL: '' })).toBe('local');
  });

  test('slugifies a production hostname', () => {
    expect(getEnvironmentSlug({ VITE_APP_URL: 'https://openstory.so' })).toBe(
      'openstory-so'
    );
  });

  test('slugifies a PR-preview hostname so prod and preview do not collide', () => {
    const prod = getEnvironmentSlug({
      VITE_APP_URL: 'https://openstory.so',
    });
    const preview = getEnvironmentSlug({
      VITE_APP_URL: 'https://pr-123.openstory.dev',
    });
    expect(prod).not.toBe(preview);
    expect(preview).toBe('pr-123-openstory-dev');
  });

  test('falls back to "local" when VITE_APP_URL is not a valid URL', () => {
    expect(getEnvironmentSlug({ VITE_APP_URL: 'not a url' })).toBe('local');
  });
});

describe('buildInstanceId', () => {
  test('composes envSlug + workflowName + suffix', () => {
    expect(
      buildInstanceId({
        env: { VITE_APP_URL: 'https://openstory.so' },
        workflowName: 'image',
        suffix: 'seq-123:frame-7',
      })
    ).toBe('openstory-so:image:seq-123:frame-7');
  });

  test('PR preview gets a distinct ID from production for the same suffix', () => {
    const prod = buildInstanceId({
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'seq-123:frame-7',
    });
    const preview = buildInstanceId({
      env: { VITE_APP_URL: 'https://pr-123.openstory.dev' },
      workflowName: 'image',
      suffix: 'seq-123:frame-7',
    });
    expect(prod).not.toBe(preview);
  });

  test('strips unsafe characters from the suffix', () => {
    expect(
      buildInstanceId({
        env: { VITE_APP_URL: 'https://openstory.so' },
        workflowName: 'image',
        suffix: 'seq 123 / frame*7',
      })
    ).toBe('openstory-so:image:seq-123-frame-7');
  });

  test('truncates suffix to keep ID under 100 chars', () => {
    const id = buildInstanceId({
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'x'.repeat(200),
    });
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id.startsWith('openstory-so:image:')).toBe(true);
  });

  test('throws when prefix alone exceeds the 100-char limit', () => {
    expect(() =>
      buildInstanceId({
        env: { VITE_APP_URL: `https://${'x'.repeat(120)}.example.com` },
        workflowName: 'image',
        suffix: 'frame-7',
      })
    ).toThrow(/exceeds the 100-char limit/);
  });
});
