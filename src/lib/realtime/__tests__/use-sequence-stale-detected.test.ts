/**
 * Tests for the testable pieces of `useSequenceStaleDetected`. The hook
 * itself is React-lifecycle-bound; cross-sequence attribution and timer
 * cleanup are covered by manual smoke testing in the theatre/music routes.
 */

import { describe, expect, it } from 'bun:test';
import { formatSequenceStaleToastMessage } from '@/lib/realtime/use-sequence-stale-detected';

describe('formatSequenceStaleToastMessage', () => {
  it('uses singular merged-video phrasing for one alternate', () => {
    expect(formatSequenceStaleToastMessage(1, 'merged-video')).toBe(
      'An alternate merged video is available.'
    );
  });

  it('uses singular music phrasing for one alternate', () => {
    expect(formatSequenceStaleToastMessage(1, 'music')).toBe(
      'An alternate music track is available.'
    );
  });

  it('pluralizes the artifact label for counts greater than one', () => {
    expect(formatSequenceStaleToastMessage(2, 'merged-video')).toBe(
      '2 alternate merged videos are available.'
    );
    expect(formatSequenceStaleToastMessage(3, 'music')).toBe(
      '3 alternate music tracks are available.'
    );
  });

  it('falls back to the generic "alternate" label when artifacts are mixed', () => {
    expect(formatSequenceStaleToastMessage(1, 'mixed')).toBe(
      'An alternate is available.'
    );
    expect(formatSequenceStaleToastMessage(4, 'mixed')).toBe(
      '4 alternates are available.'
    );
  });
});
