import { useNavigate } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';

type UseSwipeNavigationOptions = {
  routes: string[];
  currentRoute: string;
  threshold?: number;
};

export function useSwipeNavigation({
  routes,
  currentRoute,
  threshold = 50,
}: UseSwipeNavigationOptions) {
  const navigate = useNavigate();
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  const currentIndex = routes.findIndex((r) => currentRoute.endsWith(r));
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < routes.length - 1;

  const goNext = useCallback(() => {
    if (canGoNext) {
      void navigate({ to: routes[currentIndex + 1] });
    }
  }, [canGoNext, navigate, routes, currentIndex]);

  const goPrev = useCallback(() => {
    if (canGoPrev) {
      void navigate({ to: routes[currentIndex - 1] });
    }
  }, [canGoPrev, navigate, routes, currentIndex]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = touch.clientY - touchStartY.current;

      // Only trigger if horizontal swipe is dominant
      if (Math.abs(deltaX) < threshold || Math.abs(deltaY) > Math.abs(deltaX)) {
        return;
      }

      if (deltaX > 0) {
        goPrev();
      } else {
        goNext();
      }
    },
    [threshold, goPrev, goNext]
  );

  return {
    onTouchStart,
    onTouchEnd,
    currentIndex,
    canGoNext,
    canGoPrev,
    goNext,
    goPrev,
  };
}
