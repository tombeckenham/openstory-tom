import { getRealtime } from '@/lib/realtime';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const channelInputSchema = z.object({ channel: z.string().min(1) });

/**
 * Fetches all events from an Upstash Realtime channel's history.
 * Used to replay generation progress state after page refresh.
 */
export const getChannelHistoryFn = createServerFn({ method: 'GET' })
  .inputValidator(zodValidator(channelInputSchema))
  .handler(async ({ data }) => {
    const realtime = getRealtime();
    const messages = await realtime.channel(data.channel).history();

    // Redis streams store field values as strings, so msg.data may already be
    // a JSON string. Normalize each to an object before re-stringifying for
    // transport (the framework rejects `unknown` in return types).
    return messages.map((msg) => {
      const normalizedData =
        typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      return {
        id: msg.id,
        event: msg.event,
        channel: msg.channel,
        data: JSON.stringify(normalizedData),
      };
    });
  });
