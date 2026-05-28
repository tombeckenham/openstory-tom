/**
 * LogTape configuration + helpers — the canonical logger for OpenStory.
 *
 * Server: emits one JSON line per record to console.log. Cloudflare Workers
 * Observability picks these up and forwards to PostHog Logs via the
 * dashboard-configured destination.
 *
 * Browser: forwards to posthog.captureLog when available. Falls back to a
 * pretty console in dev.
 *
 * Use:
 *   const logger = getLogger(['openstory', 'workflow', 'motion']);
 *   logger.info('step started', { workflowRunId, sceneId });
 */

import {
  configureSync,
  defaultConsoleFormatter,
  type ConsoleFormatter,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type LogLevel,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from '@logtape/logtape';
import { redactByPattern, type RedactionPattern } from '@logtape/redaction';
import { z } from 'zod';
import { handleApiError, OpenStoryError } from '@/lib/errors';

const REDACT = '[REDACTED]';

/**
 * Redaction patterns for secrets that should never reach a log sink.
 * Ported from the previous src/lib/observability/structured-log.ts.
 * Each pattern MUST have the `g` flag (required by `@logtape/redaction`).
 */
const SECRET_PATTERNS: readonly RedactionPattern[] = [
  {
    pattern:
      /\b(sk|pk|fal|key|token|secret|password|bearer)[-_]?[a-zA-Z0-9\-_.]{16,}\b/gi,
    replacement: REDACT,
  },
  {
    pattern: /\b(postgres|mysql|redis|libsql|https?):\/\/[^\s"']+@[^\s"']+/gi,
    replacement: REDACT,
  },
  { pattern: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, replacement: REDACT },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACT },
  {
    pattern: /\b[A-Za-z0-9_-]{40}\b(?=.*(?:token|key|secret))/gi,
    replacement: REDACT,
  },
];

const isBrowser = (): boolean => typeof window !== 'undefined';
const isDevelopment = (): boolean => process.env.NODE_ENV !== 'production';

let configured = false;

/**
 * Configure LogTape. Idempotent — safe to call on hot-reload and from both
 * server entry (instrumentation.ts) and browser entry (ObservabilityProvider).
 */
export function configureLogging(): void {
  if (configured) return;
  configured = true;

  const dev = isDevelopment();
  const browser = isBrowser();
  const level: LogLevel = dev ? 'debug' : 'info';

  const sinks: Record<string, Sink> = browser
    ? buildBrowserSinks(dev)
    : buildServerSinks(dev);

  configureSync({
    sinks,
    loggers: [
      {
        category: ['openstory'],
        sinks: Object.keys(sinks),
        lowestLevel: level,
      },
      // Silence LogTape's own meta logger except for errors. Without this,
      // every dropped log record warning floods the console.
      {
        category: ['logtape', 'meta'],
        sinks: Object.keys(sinks),
        lowestLevel: 'error',
      },
    ],
  });
}

function buildServerSinks(dev: boolean): Record<string, Sink> {
  // In dev, lazily try to load @logtape/pretty for nicer output. The package
  // ships as a devDependency and the dynamic import lets Vite tree-shake it
  // out of the production worker bundle entirely.
  const formatter: TextFormatter = dev
    ? redactByPattern(loadDevFormatter(), SECRET_PATTERNS)
    : redactByPattern(getJsonLinesFormatter(), SECRET_PATTERNS);

  return { console: getConsoleSink({ formatter }) };
}

type PrettyModule = typeof import('@logtape/pretty');

function loadDevFormatter(): TextFormatter {
  try {
    // Synchronous require keeps configureLogging() sync. The whole `dev`
    // branch is dead-code-eliminated in prod because process.env.NODE_ENV is
    // statically replaced — so the prod bundle never ships @logtape/pretty.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const mod = require('@logtape/pretty') as PrettyModule;
    return mod.getPrettyFormatter({ timestamp: 'time' });
  } catch {
    // Pretty formatter unavailable (production build that stripped it) — fall
    // back to JSON. Shouldn't happen in dev because @logtape/pretty is a
    // devDependency.
    return getJsonLinesFormatter();
  }
}

function buildBrowserSinks(dev: boolean): Record<string, Sink> {
  if (dev) {
    const consoleFormatter: ConsoleFormatter = defaultConsoleFormatter;
    return { console: getConsoleSink({ formatter: consoleFormatter }) };
  }

  // Production browser: ship to PostHog, plus pass warn/error through to
  // DevTools so SREs can still see failures when inspecting a live page.
  const passthroughFormatter: ConsoleFormatter = defaultConsoleFormatter;
  return {
    posthog: posthogBrowserSink,
    console: getConsoleSink({
      formatter: passthroughFormatter,
      levelMap: {
        trace: 'debug',
        debug: 'debug',
        info: 'log',
        warning: 'warn',
        error: 'error',
        fatal: 'error',
      },
    }),
  };
}

type PosthogCaptureLog = (input: {
  severity: LogLevel;
  body: string;
  attributes?: Record<string, unknown>;
}) => void;

type PosthogLike = {
  captureLog?: PosthogCaptureLog;
};

declare global {
  interface Window {
    posthog?: PosthogLike;
  }
}

function getBrowserPosthog(): PosthogLike | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.posthog;
  return value && typeof value.captureLog === 'function' ? value : undefined;
}

const posthogBrowserSink: Sink = (record: LogRecord): void => {
  const posthog = getBrowserPosthog();
  if (!posthog?.captureLog) return;

  posthog.captureLog({
    severity: record.level,
    body: redactString(renderMessage(record.message)),
    attributes: {
      category: record.category.join('.'),
      timestamp: record.timestamp,
      ...redactProperties(record.properties),
    },
  });
};

function renderMessage(message: readonly unknown[]): string {
  return message
    .map((part) =>
      typeof part === 'string'
        ? part
        : (() => {
            try {
              return JSON.stringify(part);
            } catch {
              return String(part);
            }
          })()
    )
    .join('');
}

function redactString(input: string): string {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replaceAll(
      pattern,
      typeof replacement === 'string' ? replacement : REDACT
    );
  }
  return out;
}

function redactProperties(
  props: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = typeof value === 'string' ? redactString(value) : value;
  }
  return out;
}

// ============================================================================
// Public helpers
// ============================================================================

export { getLogger };

const apiLoggerRoot = getLogger(['openstory', 'api']);

type ApiHandlerArgs = {
  request: Request;
  params: Record<string, string>;
};

/**
 * Wrap an API route handler with structured request logging. Emits one info
 * log on success and one error log on failure or non-2xx response. Replaces
 * the legacy `withApiLogging` helper.
 */
export function logApiRequest(
  routeName: string,
  handler: (args: ApiHandlerArgs) => Promise<Response>
): (args: ApiHandlerArgs) => Promise<Response> {
  const logger = apiLoggerRoot.getChild(routeName);

  return async (args) => {
    const start = performance.now();
    const { request } = args;
    const contentLength = request.headers.get('content-length');
    const path = new URL(request.url).pathname;
    const baseCtx = {
      route: routeName,
      method: request.method,
      path,
      contentLength: contentLength ? Number(contentLength) : undefined,
    };

    try {
      const response = await handler(args);
      const durationMs = Math.round(performance.now() - start);
      const isErr = response.status >= 400;

      if (isErr) {
        const errorDetail = await parseErrorResponse(response);
        logger.error('api error response', {
          ...baseCtx,
          durationMs,
          status: response.status,
          err: errorDetail,
        });
      } else {
        logger.info('api ok', {
          ...baseCtx,
          durationMs,
          status: response.status,
        });
      }

      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const handled = handleApiError(error);
      logger.error('api threw', {
        ...baseCtx,
        durationMs,
        err: {
          code: handled.code,
          message: handled.message,
          statusCode: handled.statusCode,
        },
      });
      throw error;
    }
  };
}

const errorBodySchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  message: z.string().optional(),
});

async function parseErrorResponse(
  response: Response
): Promise<{ code: string; message: string; statusCode: number }> {
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    const jsonResult = errorBodySchema.safeParse(safeJsonParse(text));
    if (jsonResult.success) {
      const body = jsonResult.data;
      return {
        code: body.error?.code ?? `HTTP_${response.status}`,
        message: body.error?.message ?? body.message ?? response.statusText,
        statusCode: response.status,
      };
    }
    const message =
      text.length > 0
        ? text.length > 200
          ? `${text.slice(0, 200)}…`
          : text
        : response.statusText;
    return {
      code: `HTTP_${response.status}`,
      message,
      statusCode: response.status,
    };
  } catch {
    return {
      code: `HTTP_${response.status}`,
      message: response.statusText,
      statusCode: response.status,
    };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Standardised error payload for logger.error('...', { err }).
 * Normalises OpenStoryError vs unknown into a stable shape.
 */
export function toErrorPayload(error: unknown): {
  code: string;
  message: string;
  statusCode?: number;
  stack?: string;
} {
  if (error instanceof OpenStoryError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message, stack: error.stack };
  }
  return { code: 'UNKNOWN', message: String(error) };
}

type WorkflowContext = {
  workflowRunId?: string;
  userId?: string;
  teamId?: string;
};

/**
 * Get a child logger scoped to a workflow with run/user/team context bound.
 * Use at the top of each workflow definition:
 *
 *   const logger = getWorkflowLogger('motion-prompt-scene', { workflowRunId: context.workflowRunId });
 */
export function getWorkflowLogger(
  workflowName: string,
  context: WorkflowContext = {}
) {
  return getLogger(['openstory', 'workflow', workflowName]).with(context);
}
