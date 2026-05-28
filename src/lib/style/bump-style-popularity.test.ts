import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockCapture = mock();
const mockGetClient: ReturnType<
  typeof mock<() => { capture: typeof mockCapture } | null>
> = mock(() => ({ capture: mockCapture }));

const mockLoggerError = mock();
const mockLoggerInfo = mock();
const mockLoggerWarn = mock();
const mockLoggerDebug = mock();
const mockLoggerWith = mock(() => mockLoggerInstance);
const mockLoggerInstance = {
  info: mockLoggerInfo,
  warn: mockLoggerWarn,
  error: mockLoggerError,
  debug: mockLoggerDebug,
  with: mockLoggerWith,
  getChild: () => mockLoggerInstance,
};

mock.module('@/lib/posthog-server', () => ({
  getPostHogClient: mockGetClient,
}));

mock.module('@/lib/observability/logger', () => ({
  getLogger: () => mockLoggerInstance,
}));

const { bumpStylePopularity } = await import('./bump-style-popularity');

const baseArgs = {
  styleId: 'style_01',
  sequenceIds: ['seq_01'],
  teamId: 'team_01',
  userId: 'user_01',
};

describe('bumpStylePopularity', () => {
  beforeEach(() => {
    mockCapture.mockClear();
    mockLoggerError.mockClear();
    mockGetClient.mockReset();
    mockGetClient.mockImplementation(() => ({ capture: mockCapture }));
  });

  it('calls incrementUsage exactly once with the styleId', () => {
    const incrementUsage = mock(() => Promise.resolve());
    bumpStylePopularity({
      ...baseArgs,
      scopedDb: { styles: { incrementUsage } },
    });
    expect(incrementUsage).toHaveBeenCalledTimes(1);
    expect(incrementUsage).toHaveBeenCalledWith('style_01');
  });

  it('captures style_selected exactly once when posthog is configured', () => {
    bumpStylePopularity({
      ...baseArgs,
      scopedDb: { styles: { incrementUsage: mock(() => Promise.resolve()) } },
    });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user_01',
      event: 'style_selected',
      properties: {
        styleId: 'style_01',
        sequenceIds: ['seq_01'],
        teamId: 'team_01',
      },
    });
  });

  it('skips posthog when no client is configured', () => {
    mockGetClient.mockReturnValueOnce(null);
    bumpStylePopularity({
      ...baseArgs,
      scopedDb: { styles: { incrementUsage: mock(() => Promise.resolve()) } },
    });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('does not throw or reject when incrementUsage rejects', async () => {
    const err = new Error('db down');
    const incrementUsage = mock(() => Promise.reject(err));

    // Synchronous call must not throw.
    expect(() =>
      bumpStylePopularity({
        ...baseArgs,
        scopedDb: { styles: { incrementUsage } },
      })
    ).not.toThrow();

    // Let microtasks flush so the .catch handler runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockLoggerError).toHaveBeenCalledWith(
      'incrementUsage failed',
      expect.objectContaining({
        styleId: 'style_01',
        teamId: 'team_01',
        userId: 'user_01',
        sequenceCount: 1,
        err,
      })
    );
  });
});
