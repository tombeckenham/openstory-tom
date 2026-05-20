import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const envState: { CF_WORKFLOWS_ENABLED?: string } = {};

mock.module('#env', () => ({
  getEnv: () => envState,
}));

describe('getEngineForWorkflow', () => {
  beforeEach(() => {
    delete envState.CF_WORKFLOWS_ENABLED;
  });
  afterEach(() => {
    delete envState.CF_WORKFLOWS_ENABLED;
  });

  test('defaults every workflow to qstash', async () => {
    const { getEngineForWorkflow } =
      await import('@/lib/workflow/cf/engine-registry');
    expect(getEngineForWorkflow('image')).toBe('qstash');
    expect(getEngineForWorkflow('/image')).toBe('qstash');
    expect(getEngineForWorkflow('storyboard')).toBe('qstash');
  });

  test('CF_WORKFLOWS_ENABLED canaries the named workflow to cloudflare', async () => {
    envState.CF_WORKFLOWS_ENABLED = 'image';
    const { getEngineForWorkflow } =
      await import('@/lib/workflow/cf/engine-registry');
    expect(getEngineForWorkflow('image')).toBe('cloudflare');
    expect(getEngineForWorkflow('/image')).toBe('cloudflare');
    // Other workflows still on qstash
    expect(getEngineForWorkflow('storyboard')).toBe('qstash');
  });

  test('CF_WORKFLOWS_ENABLED accepts a comma-separated list and tolerates whitespace', async () => {
    envState.CF_WORKFLOWS_ENABLED = ' image, /motion ,storyboard';
    const { getEngineForWorkflow } =
      await import('@/lib/workflow/cf/engine-registry');
    expect(getEngineForWorkflow('image')).toBe('cloudflare');
    expect(getEngineForWorkflow('motion')).toBe('cloudflare');
    expect(getEngineForWorkflow('storyboard')).toBe('cloudflare');
    expect(getEngineForWorkflow('character-sheet')).toBe('qstash');
  });

  test('CF_WORKFLOWS_ENABLED=all routes every workflow to cloudflare', async () => {
    envState.CF_WORKFLOWS_ENABLED = 'all';
    const { getEngineForWorkflow } =
      await import('@/lib/workflow/cf/engine-registry');
    expect(getEngineForWorkflow('image')).toBe('cloudflare');
    expect(getEngineForWorkflow('storyboard')).toBe('cloudflare');
    expect(getEngineForWorkflow('something-not-yet-defined')).toBe(
      'cloudflare'
    );
  });

  test('CF_WORKFLOWS_ENABLED=* is also a wildcard', async () => {
    envState.CF_WORKFLOWS_ENABLED = '*';
    const { getEngineForWorkflow } =
      await import('@/lib/workflow/cf/engine-registry');
    expect(getEngineForWorkflow('image')).toBe('cloudflare');
    expect(getEngineForWorkflow('analyze-script')).toBe('cloudflare');
  });
});
