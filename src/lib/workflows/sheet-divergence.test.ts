import { describe, expect, it } from 'bun:test';
import { decideSheetDivergence } from './sheet-divergence';

describe('decideSheetDivergence', () => {
  it('returns convergent when both hashes match', () => {
    const result = decideSheetDivergence('hash-a', 'hash-a');
    expect(result.kind).toBe('convergent');
  });

  it('returns divergent when hashes differ', () => {
    const result = decideSheetDivergence('snapshot', 'current');
    expect(result.kind).toBe('divergent');
    if (result.kind === 'divergent') {
      expect(result.snapshotInputHash).toBe('snapshot');
      expect(result.currentInputHash).toBe('current');
    }
  });

  it('treats a missing snapshot hash as convergent (no false positives)', () => {
    expect(decideSheetDivergence(null, 'current').kind).toBe('convergent');
    expect(decideSheetDivergence(undefined, 'current').kind).toBe('convergent');
  });

  it('treats a missing current hash as convergent (parent never hashed)', () => {
    expect(decideSheetDivergence('snapshot', null).kind).toBe('convergent');
    expect(decideSheetDivergence('snapshot', undefined).kind).toBe(
      'convergent'
    );
  });
});
