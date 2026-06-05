import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import type { realtimeSchema } from './index';
import type {
  ConnectionStatus,
  EventPaths,
  EventPayloadUnion,
  RealtimeUserEvent,
} from './shared-types';

/**
 * In-repo realtime client (#802), replacing the removed Upstash-hosted realtime client.
 *
 * One `EventSource` is opened per distinct channel, ref-counted across every
 * hook that subscribes to it, and pointed at `/api/realtime?channel=…` which
 * routes through to that channel's `RealtimeChannel` Durable Object. The DO
 * holds the stream open, so the browser's native `EventSource` reconnect is the
 * only reconnection logic we need — no manual reconnect loop.
 */

type Subscriber = (msg: RealtimeUserEvent) => void;

type ChannelConnection = {
  source: EventSource;
  subscribers: Set<Subscriber>;
  status: ConnectionStatus;
};

type RealtimeContextValue = {
  status: ConnectionStatus;
  register: (id: string, channels: string[], cb: Subscriber) => void;
  unregister: (id: string) => void;
};

export const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/** Parse one SSE `data:` payload; `null` when it isn't a user event we deliver. */
function parseUserEvent(raw: string): RealtimeUserEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    'type' in payload // system event (connected / ping) — not delivered to subscribers
  ) {
    return null;
  }
  const evt = payload as Partial<RealtimeUserEvent>;
  if (typeof evt.event !== 'string' || typeof evt.channel !== 'string') {
    return null;
  }
  return {
    id: typeof evt.id === 'string' ? evt.id : '',
    event: evt.event,
    channel: evt.channel,
    data: evt.data,
  };
}

/** Collapse per-channel statuses into a single value (mirrors the old single-stream status). */
function aggregateStatus(
  connections: Map<string, ChannelConnection>
): ConnectionStatus {
  if (connections.size === 0) return 'disconnected';
  const statuses = [...connections.values()].map((c) => c.status);
  if (statuses.some((s) => s === 'connecting')) return 'connecting';
  if (statuses.every((s) => s === 'connected')) return 'connected';
  if (statuses.every((s) => s === 'error')) return 'error';
  return 'connecting';
}

export const RealtimeProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const connectionsRef = useRef<Map<string, ChannelConnection>>(new Map());
  const subscriptionsRef = useRef<
    Map<string, { channels: string[]; cb: Subscriber }>
  >(new Map());
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  const refreshStatus = () =>
    setStatus(aggregateStatus(connectionsRef.current));

  const openChannel = (channel: string): ChannelConnection => {
    const existing = connectionsRef.current.get(channel);
    if (existing) return existing;

    const source = new EventSource(
      `/api/realtime?channel=${encodeURIComponent(channel)}`
    );
    const connection: ChannelConnection = {
      source,
      subscribers: new Set(),
      status: 'connecting',
    };
    connectionsRef.current.set(channel, connection);

    source.onopen = () => {
      connection.status = 'connected';
      refreshStatus();
    };
    source.onerror = () => {
      // EventSource reconnects automatically; surface the transient error so
      // status-driven UI (toasts) can react, but don't tear the stream down.
      connection.status =
        source.readyState === EventSource.CLOSED ? 'error' : 'connecting';
      refreshStatus();
    };
    source.onmessage = (event) => {
      const msg = parseUserEvent(event.data);
      if (!msg) return;
      for (const subscriber of connection.subscribers) subscriber(msg);
    };

    refreshStatus();
    return connection;
  };

  const closeChannel = (channel: string): void => {
    const connection = connectionsRef.current.get(channel);
    if (!connection || connection.subscribers.size > 0) return;
    connection.source.close();
    connectionsRef.current.delete(channel);
    refreshStatus();
  };

  const register = (id: string, channels: string[], cb: Subscriber): void => {
    unregister(id);
    subscriptionsRef.current.set(id, { channels, cb });
    for (const channel of channels) {
      openChannel(channel).subscribers.add(cb);
    }
  };

  const unregister = (id: string): void => {
    const subscription = subscriptionsRef.current.get(id);
    if (!subscription) return;
    subscriptionsRef.current.delete(id);
    for (const channel of subscription.channels) {
      const connection = connectionsRef.current.get(channel);
      connection?.subscribers.delete(subscription.cb);
      closeChannel(channel);
    }
  };

  useEffect(() => {
    const connections = connectionsRef.current;
    const subscriptions = subscriptionsRef.current;
    return () => {
      for (const connection of connections.values()) {
        connection.source.close();
      }
      connections.clear();
      subscriptions.clear();
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ status, register, unregister }}>
      {children}
    </RealtimeContext.Provider>
  );
};

interface UseRealtimeOpts<T, E extends string> {
  events?: readonly E[];
  onData?: (arg: EventPayloadUnion<T, E>) => void;
  channels?: readonly (string | undefined)[];
  enabled?: boolean;
}

function useRealtimeImpl<T, E extends string>(
  opts: UseRealtimeOpts<T, E>
): { status: ConnectionStatus } {
  const { channels = [], events, onData, enabled } = opts;
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error(
      'useRealtime: No RealtimeProvider found. Wrap the app in <RealtimeProvider>.'
    );
  }

  const registrationId = useRef(Math.random().toString(36).slice(2)).current;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const { register, unregister } = context;
  const channelsKey = JSON.stringify(channels);
  const eventsKey = JSON.stringify(events);

  useEffect(() => {
    if (enabled === false) {
      unregister(registrationId);
      return;
    }
    const validChannels = channels.filter((channel): channel is string =>
      Boolean(channel)
    );
    if (validChannels.length === 0) {
      unregister(registrationId);
      return;
    }

    register(registrationId, validChannels, (msg) => {
      if (
        events &&
        events.length > 0 &&
        !events.some((name) => name === msg.event)
      ) {
        return;
      }
      // The DO delivers the channel's events untyped; the `events` filter above
      // guarantees `msg` matches one of the requested paths, but TS can't prove
      // the narrowing at this typed/untyped boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime-validated event/payload boundary
      onDataRef.current?.({
        event: msg.event,
        channel: msg.channel,
        data: msg.data,
      } as unknown as EventPayloadUnion<T, E>);
    });

    return () => unregister(registrationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey, eventsKey, enabled]);

  return { status: context.status };
}

/**
 * Type-safe `useRealtime` factory. Binding to `typeof realtimeSchema` gives the
 * same event-name + payload inference the call sites relied on under Upstash.
 */
function createRealtime<T extends Record<string, unknown>>() {
  return {
    useRealtime: <const E extends EventPaths<T>>(opts: UseRealtimeOpts<T, E>) =>
      useRealtimeImpl<T, E>(opts),
  };
}

export const { useRealtime } = createRealtime<typeof realtimeSchema>();
