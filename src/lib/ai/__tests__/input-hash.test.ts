import { describe, expect, it } from 'bun:test';
import {
  computeCharacterSheetInputHash,
  computeFrameAudioInputHash,
  computeFrameImageInputHash,
  computeFrameVideoInputHash,
  computeLibraryLocationReferenceInputHash,
  computeLocationSheetInputHash,
  computeMotionPromptInputHash,
  computeMusicPromptInputHash,
  computeTalentSheetInputHash,
  computeVisualPromptInputHash,
  type CharacterSheetHashInput,
  type FrameAudioHashInput,
  type FrameImageHashInput,
  type FrameVideoHashInput,
  type LibraryLocationReferenceHashInput,
  type LocationSheetHashInput,
  type TalentSheetHashInput,
} from '../input-hash';

const baseThumbnail: FrameImageHashInput = {
  kind: 'thumbnail',
  visualPrompt: 'A detective in a rainy alley, neon reflections',
  imageModel: 'flux-pro-v1.1',
  aspectRatio: '16:9',
  size: '1920x1080',
  seed: 42,
  characterSheetHashes: ['char-a', 'char-b'],
  locationSheetHashes: ['loc-1'],
  elementReferenceHashes: ['el-x'],
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('computeFrameImageInputHash (thumbnail)', () => {
  it('produces a 64-char hex SHA-256 digest', async () => {
    const hash = await computeFrameImageInputHash(baseThumbnail);
    expect(hash).toMatch(SHA256_HEX);
  });

  it('returns the same hash for identical input', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({ ...baseThumbnail });
    expect(a).toBe(b);
  });

  it('is order-insensitive for character sheet refs', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-b', 'char-a'],
    });
    expect(a).toBe(b);
  });

  it('trims free-text prompts', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      visualPrompt: `   ${baseThumbnail.visualPrompt}\n`,
    });
    expect(a).toBe(b);
  });

  it('changes when the visual prompt changes', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      visualPrompt: `${baseThumbnail.visualPrompt} at dawn`,
    });
    expect(a).not.toBe(b);
  });

  it('changes when the image model version changes', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      imageModel: 'flux-pro-v1.2',
    });
    expect(a).not.toBe(b);
  });

  it('changes when the aspect ratio, size, or seed changes', async () => {
    const base = await computeFrameImageInputHash(baseThumbnail);
    const aspect = await computeFrameImageInputHash({
      ...baseThumbnail,
      aspectRatio: '9:16',
    });
    const size = await computeFrameImageInputHash({
      ...baseThumbnail,
      size: '1280x720',
    });
    const seed = await computeFrameImageInputHash({
      ...baseThumbnail,
      seed: 99,
    });
    expect(new Set([base, aspect, size, seed]).size).toBe(4);
  });

  it('changes when a referenced character sheet hash changes', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-a', 'char-b-NEW'],
    });
    expect(a).not.toBe(b);
  });

  it('changes when location or element refs change', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const loc = await computeFrameImageInputHash({
      ...baseThumbnail,
      locationSheetHashes: ['loc-2'],
    });
    const el = await computeFrameImageInputHash({
      ...baseThumbnail,
      elementReferenceHashes: ['el-y'],
    });
    expect(new Set([a, loc, el]).size).toBe(3);
  });

  it('treats null and missing optional scalars identically', async () => {
    const explicitNulls = await computeFrameImageInputHash({
      ...baseThumbnail,
      size: null,
      seed: null,
    });
    const omitted = await computeFrameImageInputHash({
      kind: baseThumbnail.kind,
      visualPrompt: baseThumbnail.visualPrompt,
      imageModel: baseThumbnail.imageModel,
      aspectRatio: baseThumbnail.aspectRatio,
      characterSheetHashes: baseThumbnail.characterSheetHashes,
      locationSheetHashes: baseThumbnail.locationSheetHashes,
      elementReferenceHashes: baseThumbnail.elementReferenceHashes,
    });
    expect(explicitNulls).toBe(omitted);
  });
});

describe('computeFrameImageInputHash (variant-image)', () => {
  it('is distinct from the thumbnail hash for the same input', async () => {
    const thumb = await computeFrameImageInputHash(baseThumbnail);
    const variant = await computeFrameImageInputHash({
      ...baseThumbnail,
      kind: 'variant-image',
    });
    expect(variant).toMatch(SHA256_HEX);
    expect(variant).not.toBe(thumb);
  });

  it('is stable and sensitive to model change', async () => {
    const variantBase: FrameImageHashInput = {
      ...baseThumbnail,
      kind: 'variant-image',
    };
    const a = await computeFrameImageInputHash(variantBase);
    const same = await computeFrameImageInputHash({ ...variantBase });
    const different = await computeFrameImageInputHash({
      ...variantBase,
      imageModel: 'sdxl-v1',
    });
    expect(a).toBe(same);
    expect(a).not.toBe(different);
  });
});

describe('computeFrameVideoInputHash', () => {
  const base: FrameVideoHashInput = {
    sourceImage: { kind: 'variantHash', hash: 'sha-source-image' },
    motionPrompt: 'Slow dolly forward',
    motionModel: 'kling-v2.5-turbo-pro',
    durationSeconds: 5,
    fps: 30,
    aspectRatio: '16:9',
  };

  it('is stable for identical input', async () => {
    expect(await computeFrameVideoInputHash(base)).toBe(
      await computeFrameVideoInputHash({ ...base })
    );
  });

  it('changes when the motion model version changes', async () => {
    const a = await computeFrameVideoInputHash(base);
    const b = await computeFrameVideoInputHash({
      ...base,
      motionModel: 'kling-v2.6-turbo-pro',
    });
    expect(a).not.toBe(b);
  });

  it('reacts to every tracked field', async () => {
    const variants = await Promise.all([
      computeFrameVideoInputHash(base),
      computeFrameVideoInputHash({
        ...base,
        sourceImage: { kind: 'variantHash', hash: 'sha-other' },
      }),
      computeFrameVideoInputHash({ ...base, motionPrompt: 'Pan left' }),
      computeFrameVideoInputHash({ ...base, durationSeconds: 8 }),
      computeFrameVideoInputHash({ ...base, fps: 60 }),
      computeFrameVideoInputHash({ ...base, aspectRatio: '9:16' }),
    ]);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('distinguishes variantHash from url even when the string matches', async () => {
    const fromHash = await computeFrameVideoInputHash({
      ...base,
      sourceImage: { kind: 'variantHash', hash: 'shared-string' },
    });
    const fromUrl = await computeFrameVideoInputHash({
      ...base,
      sourceImage: { kind: 'url', url: 'shared-string' },
    });
    expect(fromHash).not.toBe(fromUrl);
  });
});

describe('computeFrameAudioInputHash', () => {
  const base: FrameAudioHashInput = {
    musicPrompt: 'Tense orchestral build',
    tags: ['cinematic', 'tension'],
    durationSeconds: 5,
    audioModel: 'cassette-v1',
  };

  it('is order-insensitive for tags', async () => {
    const a = await computeFrameAudioInputHash(base);
    const b = await computeFrameAudioInputHash({
      ...base,
      tags: ['tension', 'cinematic'],
    });
    expect(a).toBe(b);
  });

  it('reacts to prompt, duration, and model', async () => {
    const a = await computeFrameAudioInputHash(base);
    const prompt = await computeFrameAudioInputHash({
      ...base,
      musicPrompt: 'Soft piano',
    });
    const dur = await computeFrameAudioInputHash({
      ...base,
      durationSeconds: 9,
    });
    const model = await computeFrameAudioInputHash({
      ...base,
      audioModel: 'cassette-v2',
    });
    expect(new Set([a, prompt, dur, model]).size).toBe(4);
  });
});

describe('computeCharacterSheetInputHash', () => {
  const base: CharacterSheetHashInput = {
    characterBible: {
      name: 'Detective Sarah',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'tall, blonde, blue eyes',
      standardClothing: 'dark trench coat',
      distinguishingFeatures: 'scar above right eye',
      consistencyTag: 'sarah_blonde_30s',
    },
    talentSheetHash: 'talent-sha',
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('is stable and sensitive to bible field changes', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const same = await computeCharacterSheetInputHash({ ...base });
    const renamed = await computeCharacterSheetInputHash({
      ...base,
      characterBible: { ...base.characterBible, name: 'Detective Linda' },
    });
    expect(a).toBe(same);
    expect(a).not.toBe(renamed);
  });

  it('reacts to talent hash, style config, and image model', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const talent = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: 'talent-sha-v2',
    });
    const style = await computeCharacterSheetInputHash({
      ...base,
      styleConfigHash: 'style-sha-v2',
    });
    const model = await computeCharacterSheetInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(new Set([a, talent, style, model]).size).toBe(4);
  });

  it('treats null and missing talent hash identically', async () => {
    const nullHash = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: null,
    });
    const omitted = await computeCharacterSheetInputHash({
      characterBible: base.characterBible,
      styleConfigHash: base.styleConfigHash,
      imageModel: base.imageModel,
    });
    expect(nullHash).toBe(omitted);
  });
});

describe('computeLocationSheetInputHash', () => {
  const base: LocationSheetHashInput = {
    locationBible: { name: 'Office', description: 'Modern open-plan, glass' },
    libraryLocationReferenceHash: 'lib-sha',
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('reacts to bible, library ref, style, and model', async () => {
    const a = await computeLocationSheetInputHash(base);
    const variants = await Promise.all([
      computeLocationSheetInputHash({
        ...base,
        locationBible: { ...base.locationBible, name: 'Warehouse' },
      }),
      computeLocationSheetInputHash({
        ...base,
        libraryLocationReferenceHash: 'lib-sha-v2',
      }),
      computeLocationSheetInputHash({
        ...base,
        styleConfigHash: 'style-sha-v2',
      }),
      computeLocationSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(new Set([a, ...variants]).size).toBe(5);
  });
});

describe('computeLibraryLocationReferenceInputHash', () => {
  const base: LibraryLocationReferenceHashInput = {
    locationBible: { name: 'Office', description: 'Modern open-plan, glass' },
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('is stable, distinct from sheet hash, and reacts to model', async () => {
    const ref = await computeLibraryLocationReferenceInputHash(base);
    const refSame = await computeLibraryLocationReferenceInputHash({ ...base });
    const sheetEquivalent = await computeLocationSheetInputHash({
      ...base,
      libraryLocationReferenceHash: null,
    });
    const refModel = await computeLibraryLocationReferenceInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(ref).toBe(refSame);
    expect(ref).not.toBe(sheetEquivalent);
    expect(ref).not.toBe(refModel);
  });
});

describe('computeTalentSheetInputHash', () => {
  const base: TalentSheetHashInput = {
    talent: { name: 'Talent Name', description: 'Headshot reference' },
    referenceMediaHashes: ['m1', 'm2', 'm3'],
    imageModel: 'flux-pro-v1.1',
  };

  it('is order-insensitive for reference media', async () => {
    const a = await computeTalentSheetInputHash(base);
    const b = await computeTalentSheetInputHash({
      ...base,
      referenceMediaHashes: ['m3', 'm1', 'm2'],
    });
    expect(a).toBe(b);
  });

  it('reacts to talent fields, media set, and image model', async () => {
    const a = await computeTalentSheetInputHash(base);
    const variants = await Promise.all([
      computeTalentSheetInputHash({
        ...base,
        talent: { ...base.talent, name: 'Other Talent' },
      }),
      computeTalentSheetInputHash({
        ...base,
        referenceMediaHashes: ['m1', 'm2', 'm4'],
      }),
      computeTalentSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(new Set([a, ...variants]).size).toBe(4);
  });
});

describe('artifact discrimination', () => {
  it('returns different hashes for different artifact types with the same input shape', async () => {
    // Frame audio and video share several scalar fields; the artifact tag in
    // the canonical body keeps them distinct.
    const audio = await computeFrameAudioInputHash({
      musicPrompt: '',
      tags: [],
      durationSeconds: 5,
      audioModel: 'shared',
    });
    const video = await computeFrameVideoInputHash({
      sourceImage: { kind: 'url', url: '' },
      motionPrompt: '',
      motionModel: 'shared',
      durationSeconds: 5,
      fps: null,
      aspectRatio: '',
    });
    expect(audio).not.toBe(video);
  });
});

describe('canonical serialization', () => {
  it('produces the same digest regardless of key insertion order', async () => {
    const ordered = await computeCharacterSheetInputHash({
      characterBible: {
        name: 'Alice',
        age: '30s',
        gender: 'female',
        ethnicity: '',
        physicalDescription: 'tall',
        standardClothing: 'jacket',
        distinguishingFeatures: 'scar',
        consistencyTag: 'alice_30s',
      },
      talentSheetHash: 'talent',
      styleConfigHash: 'style',
      imageModel: 'flux-pro',
    });
    // Same fields, declared in a different order at every level.
    const shuffled = await computeCharacterSheetInputHash({
      imageModel: 'flux-pro',
      styleConfigHash: 'style',
      talentSheetHash: 'talent',
      characterBible: {
        consistencyTag: 'alice_30s',
        distinguishingFeatures: 'scar',
        standardClothing: 'jacket',
        physicalDescription: 'tall',
        ethnicity: '',
        gender: 'female',
        age: '30s',
        name: 'Alice',
      },
    });
    expect(ordered).toBe(shuffled);
  });

  it('rejects non-finite numbers rather than collapsing them to null', () => {
    expect(
      computeFrameAudioInputHash({
        musicPrompt: 'test',
        tags: [],
        durationSeconds: Number.NaN,
        audioModel: 'cassette-v1',
      })
    ).rejects.toThrow(/non-finite/);
    expect(
      computeFrameAudioInputHash({
        musicPrompt: 'test',
        tags: [],
        durationSeconds: Number.POSITIVE_INFINITY,
        audioModel: 'cassette-v1',
      })
    ).rejects.toThrow(/non-finite/);
  });
});

describe('prompt input hashes', () => {
  const sceneCtx = {
    scene: { sceneId: 's1', durationSeconds: 5 },
    styleConfig: { mood: 'neutral' },
    characterBible: [{ name: 'Alice' }],
    locationBible: [{ name: 'Beach' }],
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
  };

  it('visual and motion prompt hashes are namespaced by artifact and differ', async () => {
    const visual = await computeVisualPromptInputHash(sceneCtx);
    const motion = await computeMotionPromptInputHash(sceneCtx);
    expect(visual).not.toBe(motion);
    expect(visual).toMatch(/^[0-9a-f]{64}$/);
    expect(motion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changing the analysis model changes the visual prompt hash', async () => {
    const a = await computeVisualPromptInputHash(sceneCtx);
    const b = await computeVisualPromptInputHash({
      ...sceneCtx,
      analysisModel: 'anthropic/claude-sonnet-4.6',
    });
    expect(a).not.toBe(b);
  });

  it('music prompt hash is stable for equivalent inputs and changes with musicDesign', async () => {
    const a = await computeMusicPromptInputHash({
      musicDesign: { mood: 'epic' },
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      musicDesign: { mood: 'epic' },
      analysisModel: 'm',
    });
    const c = await computeMusicPromptInputHash({
      musicDesign: { mood: 'somber' },
      analysisModel: 'm',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
