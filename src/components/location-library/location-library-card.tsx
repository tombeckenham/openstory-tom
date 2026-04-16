import { Card } from '@/components/ui/card';
import type { LibraryLocation } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { MapPin } from 'lucide-react';

type LocationLibraryCardProps = {
  location: LibraryLocation;
  isGenerating?: boolean;
  onClick?: () => void;
};

export const LocationLibraryCard: React.FC<LocationLibraryCardProps> = ({
  location,
  isGenerating = false,
  onClick,
}) => {
  const previewUrl = location.referenceImageUrl;

  return (
    <Card
      className="group relative overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
      onClick={onClick}
    >
      {/* Preview image - 16:9 aspect ratio for locations */}
      <div className="aspect-video bg-muted relative">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={location.name}
            className={cn(
              'w-full h-full object-cover',
              isGenerating && 'opacity-50'
            )}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MapPin className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}

        {/* System badge */}
        {location.isPublic && (
          <div className="absolute top-2 left-2 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            System
          </div>
        )}
      </div>

      {/* Info section */}
      <div className="p-4">
        <h3 className="font-semibold text-sm line-clamp-1 mb-1">
          {location.name}
        </h3>

        {location.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {location.description}
          </p>
        )}
      </div>
    </Card>
  );
};
