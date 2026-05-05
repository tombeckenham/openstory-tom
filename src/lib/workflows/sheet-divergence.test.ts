import { beforeEach, describe, expect, it, mock } from 'bun:test';

const generationEmit = mock(async () => undefined);
const locationEmit = mock(async () => undefined);
const talentEmit = mock(async () => undefined);

const getGenerationChannel = mock((sequenceId?: string) => {
  generationEmit.mockClear();
  return { id: sequenceId, emit: generationEmit };
});
const getLocationChannel = mock((locationId?: string) => {
  locationEmit.mockClear();
  return { id: locationId, emit: locationEmit };
});
const getTalentChannel = mock((talentId?: string) => {
  talentEmit.mockClear();
  return { id: talentId, emit: talentEmit };
});

mock.module('@/lib/realtime', () => ({
  getGenerationChannel,
  getLocationChannel,
  getTalentChannel,
}));

const characterInsertDivergent = mock(
  async (values: Record<string, unknown>) => ({
    id: 'character-variant-id',
    ...values,
  })
);
const locationInsertDivergent = mock(
  async (values: Record<string, unknown>) => ({
    id: 'location-variant-id',
    ...values,
  })
);
const talentInsertDivergent = mock(async (values: Record<string, unknown>) => ({
  id: 'talent-variant-id',
  ...values,
}));

const scopedDbMock = {
  characterSheetVariants: { insertDivergent: characterInsertDivergent },
  locationSheetVariants: { insertDivergent: locationInsertDivergent },
  talentSheetVariants: { insertDivergent: talentInsertDivergent },
};

beforeEach(() => {
  generationEmit.mockClear();
  locationEmit.mockClear();
  talentEmit.mockClear();
  getGenerationChannel.mockClear();
  getLocationChannel.mockClear();
  getTalentChannel.mockClear();
  characterInsertDivergent.mockClear();
  locationInsertDivergent.mockClear();
  talentInsertDivergent.mockClear();
});

describe('decideSheetDivergence', () => {
  it('returns convergent when both hashes match', async () => {
    const { decideSheetDivergence } = await import('./sheet-divergence');
    const result = decideSheetDivergence('hash-a', 'hash-a');
    expect(result.kind).toBe('convergent');
  });

  it('returns divergent when hashes differ', async () => {
    const { decideSheetDivergence } = await import('./sheet-divergence');
    const result = decideSheetDivergence('snapshot', 'current');
    expect(result.kind).toBe('divergent');
    if (result.kind === 'divergent') {
      expect(result.snapshotInputHash).toBe('snapshot');
      expect(result.currentInputHash).toBe('current');
    }
  });

  it('treats missing hashes as convergent (no false positives)', async () => {
    const { decideSheetDivergence } = await import('./sheet-divergence');
    expect(decideSheetDivergence(null, 'current').kind).toBe('convergent');
    expect(decideSheetDivergence(undefined, 'current').kind).toBe('convergent');
    expect(decideSheetDivergence('snapshot', null).kind).toBe('convergent');
    expect(decideSheetDivergence('snapshot', undefined).kind).toBe(
      'convergent'
    );
  });
});

describe('saveDivergentCharacterSheet', () => {
  it('writes a divergent row and emits on the sequence channel', async () => {
    const { saveDivergentCharacterSheet } = await import('./sheet-divergence');
    // biome-ignore lint/suspicious/noExplicitAny: mocked scopedDb
    const scopedDb = scopedDbMock as any;

    const variantId = await saveDivergentCharacterSheet({
      scopedDb,
      characterId: 'char-1',
      sequenceId: 'seq-1',
      model: 'flux-pro',
      url: 'https://r2/sheet.png',
      storagePath: 'team/seq-1/char-1/x.png',
      workflowRunId: 'run-1',
      snapshotInputHash: 'hash-snap',
    });

    expect(variantId).toBe('character-variant-id');
    expect(characterInsertDivergent).toHaveBeenCalledTimes(1);
    const insertArgs = characterInsertDivergent.mock.calls[0][0];
    expect(insertArgs).toMatchObject({
      characterId: 'char-1',
      model: 'flux-pro',
      url: 'https://r2/sheet.png',
      inputHash: 'hash-snap',
    });
    expect(insertArgs.divergedAt).toBeInstanceOf(Date);

    expect(getGenerationChannel).toHaveBeenCalledWith('seq-1');
    expect(generationEmit).toHaveBeenCalledTimes(1);
    expect(generationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'character',
      entityId: 'char-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-snap',
      divergedVariantId: 'character-variant-id',
    });
  });
});

describe('saveDivergentLocationSheet', () => {
  it('routes sequence_location through the sequence channel as entityType "location"', async () => {
    const { saveDivergentLocationSheet } = await import('./sheet-divergence');
    // biome-ignore lint/suspicious/noExplicitAny: mocked scopedDb
    const scopedDb = scopedDbMock as any;

    const variantId = await saveDivergentLocationSheet({
      scopedDb,
      parent: { type: 'sequence_location', id: 'loc-1', sequenceId: 'seq-9' },
      model: 'flux-pro',
      url: 'https://r2/loc.png',
      snapshotInputHash: 'hash-loc',
    });

    expect(variantId).toBe('location-variant-id');
    expect(locationInsertDivergent).toHaveBeenCalledTimes(1);
    expect(locationInsertDivergent.mock.calls[0][0]).toMatchObject({
      parentType: 'sequence_location',
      parentId: 'loc-1',
      inputHash: 'hash-loc',
    });

    expect(getGenerationChannel).toHaveBeenCalledWith('seq-9');
    expect(getLocationChannel).not.toHaveBeenCalled();
    expect(generationEmit).toHaveBeenCalledTimes(1);
    expect(generationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'location',
      entityId: 'loc-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-loc',
      divergedVariantId: 'location-variant-id',
    });
  });

  it('routes library_location through the per-location channel as entityType "library-location"', async () => {
    const { saveDivergentLocationSheet } = await import('./sheet-divergence');
    // biome-ignore lint/suspicious/noExplicitAny: mocked scopedDb
    const scopedDb = scopedDbMock as any;

    await saveDivergentLocationSheet({
      scopedDb,
      parent: { type: 'library_location', id: 'lib-loc-1' },
      model: 'flux-pro',
      url: 'https://r2/loc.png',
      snapshotInputHash: 'hash-loc',
    });

    expect(locationInsertDivergent.mock.calls[0][0]).toMatchObject({
      parentType: 'library_location',
      parentId: 'lib-loc-1',
    });

    expect(getLocationChannel).toHaveBeenCalledWith('lib-loc-1');
    expect(getGenerationChannel).not.toHaveBeenCalled();
    expect(locationEmit).toHaveBeenCalledTimes(1);
    expect(locationEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'library-location',
      entityId: 'lib-loc-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-loc',
      divergedVariantId: 'location-variant-id',
    });
  });
});

describe('saveDivergentTalentSheet', () => {
  it('emits on the talent channel using talentId, with talentSheetId as entityId', async () => {
    const { saveDivergentTalentSheet } = await import('./sheet-divergence');
    // biome-ignore lint/suspicious/noExplicitAny: mocked scopedDb
    const scopedDb = scopedDbMock as any;

    const variantId = await saveDivergentTalentSheet({
      scopedDb,
      talentSheetId: 'sheet-1',
      talentId: 'talent-1',
      model: 'flux-pro',
      url: 'https://r2/talent.png',
      snapshotInputHash: 'hash-tal',
    });

    expect(variantId).toBe('talent-variant-id');
    expect(talentInsertDivergent.mock.calls[0][0]).toMatchObject({
      talentSheetId: 'sheet-1',
      inputHash: 'hash-tal',
    });

    expect(getTalentChannel).toHaveBeenCalledWith('talent-1');
    expect(getGenerationChannel).not.toHaveBeenCalled();
    expect(talentEmit).toHaveBeenCalledTimes(1);
    expect(talentEmit).toHaveBeenCalledWith('generation.stale:detected', {
      entityType: 'talent',
      entityId: 'sheet-1',
      artifact: 'sheet',
      snapshotInputHash: 'hash-tal',
      divergedVariantId: 'talent-variant-id',
    });
  });
});
