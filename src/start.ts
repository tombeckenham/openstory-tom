import { createStart } from '@tanstack/react-start';
import { loggerMiddleware } from '@/functions/middleware';

export const startInstance = createStart(() => ({
  functionMiddleware: [loggerMiddleware],
}));
