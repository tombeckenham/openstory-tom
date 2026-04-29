import type { Talent } from '@/lib/db/schema';

function getPublicAssetsDomain(): string {
  return import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN ?? '';
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getTalentPreviewUrl(name: string): string {
  return `https://${getPublicAssetsDomain()}/talent/${sanitizeName(name)}/thumbnail.webp`;
}

export function getTalentSheetUrl(name: string): string {
  return `https://${getPublicAssetsDomain()}/talent/${sanitizeName(name)}/sheet.webp`;
}

// Default talent templates available to all teams
export const DEFAULT_TALENT_TEMPLATES: Array<
  Omit<Talent, 'id' | 'teamId' | 'createdAt' | 'updatedAt' | 'createdBy'>
> = [
  {
    name: 'Sienna Blake',
    description:
      'Golden blonde, beach-tanned skin, effortless Bondi energy. Wide smile, freckles across the nose, the kind of face that sells skincare without trying. Perfect for product ads, lifestyle campaigns, and rom-com leads.',
    isHuman: true,
    isFavorite: false,
    isInTeamLibrary: false,
    isPublic: true,
    isTemplate: true,
    imageUrl: getTalentPreviewUrl('Sienna Blake'),
    imagePath: null,
  },
  {
    name: 'Jude Calloway',
    description:
      'Dark features, strong brow, salt-wind-tousled hair. Ruggedly photogenic with an easy grin. Equally at home in a real estate walkthrough, a whiskey ad, or an action sequence on a rooftop.',
    isHuman: true,
    isFavorite: false,
    isInTeamLibrary: false,
    isPublic: true,
    isTemplate: true,
    imageUrl: getTalentPreviewUrl('Jude Calloway'),
    imagePath: null,
  },
  {
    name: 'Rani Sharma',
    description:
      'Deep brown eyes, sleek black hair, razor-sharp cheekbones. Elegant intensity with a warmth underneath. Born for corporate power plays, award-season drama, and luxury brand spots.',
    isHuman: true,
    isFavorite: false,
    isInTeamLibrary: false,
    isPublic: true,
    isTemplate: true,
    imageUrl: getTalentPreviewUrl('Rani Sharma'),
    imagePath: null,
  },
];

// System talent with timestamps for seeding
export const DEFAULT_SYSTEM_TALENT: Array<
  Omit<Talent, 'id' | 'teamId' | 'createdBy'>
> = DEFAULT_TALENT_TEMPLATES.map((t) => ({
  ...t,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
