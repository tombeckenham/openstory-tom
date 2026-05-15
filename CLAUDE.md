# CLAUDE.md

AI-powered video sequence platform built with TanStack Start, optimized for edge deployment.

## Architecture Overview

**Tech Stack:**

- **Runtime**: Bun (not Node.js)
- **Framework**: TanStack Start + TanStack Router + Vite
- **Database**: Turso (libSQL/SQLite) + Drizzle ORM
- **Workflows**: QStash (durable execution for AI tasks)
- **Storage**: Cloudflare R2 (S3-compatible)
- **Auth**: Better Auth
- **Styling**: Tailwind v4 + shadcn/ui
- **Testing**: Bun test

**Core Principles:**

- Database access ONLY in server handlers (never in components)
- Anonymous-first → upgrade to save work
- Team-based resources (sequences, styles, characters)
- Script-driven generation for consistency

**Data Model:**

```
teams
  ├── users (members)
  ├── sequences (videos)
  │   └── frames (scenes with metadata)
  └── libraries (styles, characters, vfx, audio)
```

---

## Setup

```bash
bun install
bun setup                          # Auto-configure local dev (SQLite + QStash)
bun db:setup                       # Migrate + seed database
```

**Daily workflow (2 terminals):**

- Terminal 1: `bun qstash:dev` (async job processing)
- Terminal 2: `bun dev`

**Before commit:** Lefthook auto-checks quality. Branch `123-feature` → commits tagged `#123`.

---

## Server Handler Pattern

All API routes use TanStack Start server handlers:

```typescript
// src/routes/api/example/$id.ts
import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { requireUser } from '@/lib/auth/action-utils';
import { handleApiError } from '@/lib/errors';

export const Route = createFileRoute('/api/example/$id')({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        try {
          // 1. Validate input
          const input = schema.parse(await request.json());

          // 2. Check auth/team permissions
          const user = await requireUser();

          // 3. Execute business logic (DB operations ONLY here)
          const record = await db.insert(table).values({
            ...input,
            teamId: user.teamId,
          });

          // 4. Trigger workflows for async AI tasks
          const { messageId } = await qstash.publishJSON({
            url: `${getQStashWebhookUrl()}/workflows/image`,
            body: { userId: user.id, teamId: user.teamId, ...input },
          });

          // 5. Return standardized response
          return json({ id: record.id, workflowRunId: messageId });
        } catch (error) {
          const handledError = handleApiError(error);
          return json(
            { success: false, error: handledError.toJSON() },
            { status: handledError.statusCode }
          );
        }
      },
    },
  },
});
```

---

## Workflow Pattern

**Triggering workflows (from server handlers):**

```typescript
// ❌ WRONG - Direct fetch() calls don't include QStash signatures
await fetch('/api/workflows/image', {
  method: 'POST',
  body: JSON.stringify(data),
});

// ✅ CORRECT - Use qstash.publishJSON() for proper signatures
const qstash = getQStashClient();
const { messageId } = await qstash.publishJSON({
  url: `${getQStashWebhookUrl()}/workflows/image`, // External URL QStash can reach
  body: { userId, teamId, prompt, ...params },
});
const workflowRunId = messageId;
```

**Implementing workflows (TanStack Start + serveMany):**

```typescript
// src/routes/api/workflows/$.ts - Register with serveMany
import { createFileRoute } from '@tanstack/react-router';
import { serveMany } from '@upstash/workflow/tanstack';

const handler = serveMany({
  image: generateImageWorkflow,
  motion: generateMotionWorkflow,
  storyboard: generateStoryboardWorkflow,
});

export const Route = createFileRoute('/api/workflows/$')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return handler.POST({ request });
      },
    },
  },
});

// Individual workflow (src/lib/workflows/image-workflow.ts)
export const generateImageWorkflow = async (
  context: WorkflowContext<ImageWorkflowInput>
) => {
  const input = context.requestPayload;
  validateWorkflowAuth(input); // Check userId/teamId passed through context

  const result = await context.run('generate-image', async () => {
    // Step logic - automatically retried on failure
    const image = await generateImage(input.prompt);

    // Update database directly
    await db
      .update(frames)
      .set({ thumbnailUrl: image.url })
      .where(eq(frames.id, input.frameId));

    return { imageUrl: image.url };
  });

  return result;
};
```

**Key principles:**

- Workflows handle their own state (no DB job tracking needed)
- Pass auth (userId/teamId) through workflow context
- Steps are durable - execution continues even if server restarts
- Update DB records directly in workflow steps

---

## Frame System

Frames are the core content unit - each represents one scene from script analysis.

**Frame Structure:**

- `thumbnailUrl` - Generated image
- `videoUrl` - Motion video (image-to-video)
- `metadata` - Complete `Scene` object (typed JSONB)

**Frame.metadata IS the Scene object** (no wrapper):

```typescript
// src/lib/ai/frame.schema.ts
frame.metadata = {
  sceneId: string,
  sceneNumber: number,
  originalScript: { extract, lineNumber, dialogue },
  metadata: { title, durationSeconds, location, timeOfDay, storyBeat },
  variants: { cameraAngles, movementStyles, moodTreatments }, // A/B/C options
  selectedVariant: { cameraAngle, movementStyle, moodTreatment, rationale },
  prompts: {
    visual: { fullPrompt, negativePrompt, components, parameters },
    motion: { fullPrompt, components, parameters },
  },
  continuity: { characterTags, environmentTag, colorPalette, lightingSetup },
  musicDesign: { presence, style, mood, atmosphere },
};
```

**Working with frames:**

```typescript
import { frameService } from '@/lib/services/frame.service';

// Get scene data (metadata IS the scene)
const scene = frameService.getSceneData(frame);

// Get prompts for regeneration
const visualPrompt = frameService.getVisualPrompt(frame);
const motionPrompt = frameService.getMotionPrompt(frame);

// Access directly (fully typed!)
const sceneTitle = frame.metadata.metadata.title;
const fullPrompt = frame.metadata.prompts.visual.fullPrompt;
```

**Benefits:**

- Complete scene data enables regeneration without re-analyzing script
- Variants preserved for trying different creative options
- Type-safe with Drizzle's typed JSONB

---

## Fal.ai Integration

**Always verify API specs before updating models:**

```bash
# Get authoritative parameter specifications
https://fal.ai/models/{model-path}/llms.txt

# Examples
https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/llms.txt
https://fal.ai/models/fal-ai/fast-svd-lcm/llms.txt
```

**Why `/llms.txt`?**

- Machine-readable, authoritative specs
- Includes all parameters with types, defaults, constraints
- More reliable than HTML docs
- Essential for accurate `src/lib/ai/models.ts` definitions

**Motion generation status checking:**

```typescript
// Generate motion
const result = await generateMotionForFrame({
  imageUrl: 'https://example.com/image.jpg',
  prompt: 'Camera pan left',
  model: 'wan_i2v',
});
// result.requestId, result.statusUrl, result.responseUrl, result.cancelUrl

// Check status
import {
  checkMotionStatus,
  getMotionResult,
  cancelMotionGeneration,
} from '@/lib/services/motion.service';

const status = await checkMotionStatus(result.statusUrl);
// status.status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED"

const video = await getMotionResult(result.responseUrl);
await cancelMotionGeneration(result.cancelUrl);
```

**CLI status checking:**

```bash
bun scripts/check-motion-status.ts <status-url>
bun scripts/check-motion-status.ts --result <response-url>
bun scripts/check-motion-status.ts --cancel <cancel-url>
```

---

## Database Patterns

**Schema management:**

```bash
bun db:generate  # Generate migrations from schema changes
bun db:migrate   # Apply migrations to local.db
```

**Key conventions:**

- Schema in `src/lib/db/schema/` (Drizzle auto-infers types)
- **NEVER** manually write migration SQL files
- **ULID** primary keys (not UUID)
- **Typed JSONB**: `frame.metadata` typed as `Scene`
- **DB access ONLY in server handlers** (never in components)

### D1 / Turso table-rebuild trap (read before changing schema)

drizzle-kit's HTTP migrators (`d1-http`, `turso`) join all migration statements into a single HTTP body. Both D1 and Turso libSQL wrap multi-statement bodies in an implicit transaction, and SQLite **silently** ignores `PRAGMA foreign_keys = OFF` inside a transaction. So when the standard SQLite "table rebuild" pattern (`CREATE __new_X` → `INSERT SELECT` → `DROP X` → `RENAME`) drops the parent table, every inbound `ON DELETE CASCADE` FK fires and child rows are deleted.

This is what destroyed `team_members`, `session`, `account`, and `passkey` in production on 2026-04-29 (issue #612, migration `20260428013041_productive_kabuki`). `PRAGMA defer_foreign_keys = ON` does **not** help — it defers constraint _checks_ but CASCADE still fires.

**Workarounds (in order of preference):**

1. **Avoid table rebuilds.** Prefer `ALTER TABLE … RENAME COLUMN / ADD COLUMN / DROP COLUMN`. SQLite (and D1/Turso) supports these without a rebuild.
2. **Apply destructive migrations manually.** Run `wrangler d1 export` to snapshot first, then apply the migration file directly via the D1 dashboard or `wrangler d1` (the `--file=…` form). Do not let `db:migrate:turso` / `db:migrate:d1` run it.
3. **Avoid `ON DELETE CASCADE`** on FKs to long-lived parent tables (`user`, `teams`, `sequences`). Use `'restrict'` or `'no action'` and clean up children in app code.

**Local guardrail:** `scripts/check-migrations.ts` runs as a Lefthook pre-commit step on staged `drizzle/migrations/**/*.sql` files. It flags `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, and `ALTER TABLE … DROP COLUMN`, and annotates each `DROP TABLE` with the count of inbound `ON DELETE CASCADE` FKs it found in the schema (so a high blast radius is visible at commit time). To bypass for a migration you've decided to apply manually: `bun scripts/check-migrations.ts --allow-destructive`.

References: [drizzle-orm#3065](https://github.com/drizzle-team/drizzle-orm/issues/3065), [workers-sdk#5438](https://github.com/cloudflare/workers-sdk/issues/5438), [SQLite foreign_keys docs](https://sqlite.org/foreignkeys.html#fk_enable).

---

## React Patterns

### Data Fetching

```tsx
// ❌ BAD - useState + useEffect
import { useEffect, useState } from 'react';

export default function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        setUser(data);
        setIsLoading(false);
      });
  }, [userId]);

  if (isLoading) return <div>Loading...</div>;
  return <div style={{ fontSize: 16, color: '#333' }}>{user.name}</div>;
}

// ✅ GOOD - TanStack Query + Suspense + vanilla TS logic
import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUserName } from '@/lib/users/format'; // vanilla TS function

const UserProfileContent: React.FC<{ userId: string }> = ({ userId }) => {
  const { data: user } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetchUser(userId), // vanilla TS function
    suspense: true, // No isLoading checks needed
  });

  return <div className="text-base">{formatUserName(user)}</div>;
};

export const UserProfile: React.FC<{ userId: string }> = ({ userId }) => {
  return (
    <Suspense fallback={<Skeleton className="h-6 w-32" />}>
      <UserProfileContent userId={userId} />
    </Suspense>
  );
};
```

### Styling

```tsx
// ❌ BAD - Excessive inline Tailwind, hard-coded colors
export default function FrameCard({ frame, onSelect }) {
  return (
    <div
      className="w-[300px] h-[200px] m-4 p-6 bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-xl shadow-lg hover:shadow-xl transition-shadow border border-slate-200 dark:border-slate-700"
      onClick={onSelect}
    >
      <h3 className="text-xl font-bold mb-2 text-slate-900 dark:text-white">
        {frame.title}
      </h3>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {frame.description}
      </p>
    </div>
  );
}

// ✅ GOOD - shadcn/ui base components + layout-only Tailwind
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

type FrameCardProps = {
  frame: Frame;
  onSelect?: () => void;
};

export const FrameCard: React.FC<FrameCardProps> = ({ frame, onSelect }) => {
  return (
    <Card onClick={onSelect} className="cursor-pointer">
      <CardHeader>
        <CardTitle>{frame.title}</CardTitle>
        <CardDescription>{frame.description}</CardDescription>
      </CardHeader>
    </Card>
  );
};

// Views use Tailwind ONLY for layout
export const FrameGrid: React.FC<{ frames: Frame[] }> = ({ frames }) => {
  return (
    <div className="grid grid-cols-3 gap-4">
      {frames.map((frame) => (
        <FrameCard key={frame.id} frame={frame} />
      ))}
    </div>
  );
};
```

**Why this is better:**

- Base `Card` component handles theming, colors, shadows automatically
- Tailwind used ONLY for layout (grid, gap, flex)
- Dark mode, hover states come from theme
- Easy to maintain - change theme, not every component

### Complex State Management

```tsx
// ❌ BAD - Multiple useState, scattered logic
import { useEffect, useState } from 'react';

function FrameEditor({ frameId }: { frameId: string }) {
  const [frame, setFrame] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('default');

  useEffect(() => {
    setIsLoading(true);
    fetch(`/api/frames/${frameId}`)
      .then((r) => r.json())
      .then((data) => {
        setFrame(data);
        setIsLoading(false);
      });
  }, [frameId]);

  if (isLoading) return <div>Loading...</div>;
  // ... complex update logic scattered across handlers
}

// ✅ GOOD - Suspense + reducer for complex state
import { Suspense, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import { frameReducer, initialState } from './frame-editor.reducer'; // vanilla TS
import { Skeleton } from '@/components/ui/skeleton';

type FrameEditorProps = {
  frameId: string;
  onUpdate?: (state: EditorState) => void;
};

const FrameEditorContent: React.FC<FrameEditorProps> = ({
  frameId,
  onUpdate,
}) => {
  const { data: frame } = useQuery({
    queryKey: ['frame', frameId],
    queryFn: () => fetchFrame(frameId),
    suspense: true,
  });

  const [state, dispatch] = useReducer(frameReducer, initialState);

  return (
    <div className="flex flex-col gap-4">
      <h2>{frame.title}</h2>
      {/* ... */}
    </div>
  );
};

export const FrameEditor: React.FC<FrameEditorProps> = (props) => {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <FrameEditorContent {...props} />
    </Suspense>
  );
};
```

**Reducer pattern (vanilla TypeScript):**

```typescript
// frame-editor.reducer.ts - Pure vanilla TypeScript
export type EditorState = {
  isEditing: boolean;
  prompt: string;
  style: string;
  isDirty: boolean;
};

export type EditorAction =
  | { type: 'START_EDIT' }
  | { type: 'UPDATE_PROMPT'; payload: string }
  | { type: 'CHANGE_STYLE'; payload: string }
  | { type: 'RESET' };

export const initialState: EditorState = {
  isEditing: false,
  prompt: '',
  style: 'default',
  isDirty: false,
};

export function frameReducer(
  state: EditorState,
  action: EditorAction
): EditorState {
  switch (action.type) {
    case 'START_EDIT':
      return { ...state, isEditing: true };
    case 'UPDATE_PROMPT':
      return { ...state, prompt: action.payload, isDirty: true };
    case 'CHANGE_STYLE':
      return { ...state, style: action.payload, isDirty: true };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}
```

### Forms

```tsx
// ❌ BAD - Controlled inputs everywhere, manual validation
import { useState } from 'react';

function ScriptForm() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [errors, setErrors] = useState({});

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title) {
      setErrors({ title: 'Required' });
      return;
    }
    await fetch('/api/scripts', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      {errors.title && <span>{errors.title}</span>}
    </form>
  );
}

// ✅ GOOD - TanStack Query mutation + Zod validation
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createScript } from '@/lib/api/scripts'; // vanilla TS function
import { scriptSchema } from '@/lib/schemas/script'; // Zod schema

export const ScriptForm: React.FC = () => {
  const mutation = useMutation({
    mutationFn: createScript,
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const result = scriptSchema.safeParse(Object.fromEntries(formData));

    if (!result.success) {
      // Handle validation errors
      return;
    }

    mutation.mutate(result.data);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Input
          name="title"
          placeholder="Script title…"
          autoComplete="off"
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          name="content"
          placeholder="Write your script…"
          className="min-h-[200px] resize-y"
          required
        />
      </div>

      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating…' : 'Create Script'}
      </Button>
    </form>
  );
};
```

### Loading States

```tsx
// ❌ BAD - Separate skeleton component, conditional rendering causes layout shift
function FrameCardSkeleton() {
  return (
    <div className="p-4 border rounded">
      <div className="h-4 bg-gray-200 rounded w-3/4" />
      <div className="h-3 bg-gray-200 rounded w-1/2 mt-2" />
    </div>
  );
}

function FrameCard({ frame, showDetails }: Props) {
  if (!frame) return <FrameCardSkeleton />;

  return (
    <div className="p-4 border rounded">
      <h3>{frame.title}</h3>
      {showDetails && <DetailPanel frame={frame} />} {/* Layout shift */}
    </div>
  );
}

// ✅ GOOD - Inline skeleton, CSS display for visibility
import { Skeleton } from '@/components/ui/skeleton';

type FrameCardProps = {
  frame?: Frame;
  showDetails?: boolean;
};

export const FrameCard: React.FC<FrameCardProps> = ({
  frame,
  showDetails = false,
}) => {
  return (
    <div className="flex flex-col gap-3 p-4 border rounded">
      {frame ? (
        <h3 className="text-lg font-semibold">{frame.title}</h3>
      ) : (
        <Skeleton className="h-6 w-3/4" />
      )}

      {/* Pre-renders but hidden - no layout shift */}
      <div className={showDetails ? 'block' : 'hidden'}>
        {frame ? (
          <DetailPanel frame={frame} />
        ) : (
          <Skeleton className="h-20 w-full" />
        )}
      </div>
    </div>
  );
};
```

### File Organization

```tsx
// ❌ BAD
// File: UserProfile.tsx (PascalCase causes git issues)
export default function Component({ id }) {
  const user = useGlobalUser(); // global state
  // No URL state - can't deep link
}

// ✅ GOOD
// File: src/components/user-profile.tsx
import { formatUserName } from '@/lib/users/format-user-name'; // vanilla TS

type UserProfileProps = {
  userId: string; // from URL params
};

export const UserProfile: React.FC<UserProfileProps> = ({ userId }) => {
  const { data: user } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetchUser(userId),
  });

  return (
    <div className="flex flex-col gap-4">
      <h1>{user ? formatUserName(user) : <Skeleton className="h-8 w-48" />}</h1>
    </div>
  );
};

// File: src/routes/_protected/users/$userId.tsx (TanStack Router)
import { createFileRoute } from '@tanstack/react-router';
import { UserProfile } from '@/components/user-profile';

export const Route = createFileRoute('/_protected/users/$userId')({
  component: RouteComponent,
});

function RouteComponent() {
  const { userId } = Route.useParams();
  return <UserProfile userId={userId} />;
}
```

### Quick Reference

- **State**: TanStack Query for server data, reducers ONLY for complex UI state
- **Loading**: Suspense instead of isLoading checks, inline `<Skeleton />` fallbacks
- **Styling**: shadcn/ui base components + layout-only Tailwind (flex, gap, grid)
- **Layout**: Flexbox + gap (never margin on components), CSS display for show/hide
- **Files**: kebab-case.tsx, named exports, vanilla TS for logic
- **Forms**: TanStack Query mutations + Zod validation
- **Routing**: TanStack Router with `createFileRoute`, params via `Route.useParams()`
- **Imports**: Direct (useState not React.useState), @ alias, no default exports

---

## UI/UX Rules (MUST/SHOULD/NEVER)

**Keyboard & Focus:**

- MUST: Full keyboard support per [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/)
- MUST: Visible focus rings (`:focus-visible`), focus management (trap/return)

**Inputs & Forms:**

- MUST: Hit targets ≥24px (mobile ≥44px), font-size ≥16px to prevent zoom
- MUST: Hydration-safe inputs, allow paste, trim values
- MUST: Enter submits text input; Ctrl/Cmd+Enter submits textarea
- MUST: Errors inline next to fields; focus first error on submit
- MUST: `autocomplete` + meaningful `name`; correct `type` and `inputmode`
- SHOULD: Placeholders end with `…`, disable spellcheck for codes/emails
- NEVER: Block paste, disable browser zoom

**State & Navigation:**

- MUST: URL reflects state (filters/tabs/pagination) - use TanStack Router search params
- MUST: Back/Forward restores scroll
- MUST: Links use TanStack Router `<Link>` (supports Cmd/Ctrl/middle-click)

**Feedback:**

- SHOULD: Optimistic UI; reconcile on response; rollback or Undo on failure
- MUST: Confirm destructive actions or provide Undo window
- MUST: Use polite `aria-live` for toasts/inline validation
- SHOULD: Ellipsis (`…`) for loading states ("Loading…", "Saving…")

**Animation:**

- MUST: Honor `prefers-reduced-motion` (provide reduced variant)
- MUST: Animate compositor-friendly props (`transform`, `opacity`)
- MUST: Animations are interruptible and input-driven (avoid autoplay)
- SHOULD: Prefer CSS > Web Animations API > JS libraries

**Accessibility:**

- MUST: Redundant status cues (not color-only), icons have text labels
- MUST: `aria-label` for icon-only buttons
- MUST: Tabular numbers (`font-variant-numeric: tabular-nums`) for comparisons
- MUST: Non-breaking spaces: `10&nbsp;MB`, `Cmd&nbsp;+&nbsp;K`
- MUST: Prefer native semantics (`button`, `a`, `label`) before ARIA
- MUST: Skeletons mirror final content to avoid layout shift

**Performance:**

- MUST: Virtualize long lists (use `virtua`)
- MUST: Prevent CLS from images (explicit dimensions or reserved space)
- MUST: Track re-renders (React DevTools/React Scan)
- MUST: Mutations (`POST/PATCH/DELETE`) target <500ms
- SHOULD: Prefer uncontrolled inputs; make controlled loops cheap

**Layout:**

- MUST: Verify mobile, laptop, ultra-wide (simulate at 50% zoom)
- MUST: Respect safe areas (`env(safe-area-inset-*)`)
- MUST: Deliberate alignment to grid/baseline/edges - no accidental placement
- SHOULD: Optical alignment; adjust by ±1px when perception beats geometry

---

## Testing

**Framework:** `bun:test` (migrated from Vitest)

**Test location:**

- Server handlers: `__tests__/` directories alongside routes
- Services/utils: Same directory as module (`service.test.ts`)

**Focus:** Business logic (not React components)

**Bun mock pattern** (avoid shared state):

```typescript
const mockDb = mock(() => ({
  /* mock implementation */
}));

mock.module('@/lib/db/client', () => ({
  db: mockDb,
}));

beforeEach(async () => {
  mockDb.mockClear(); // Clear call history
  const module = await import('./module-under-test');
});
```

**Database testing:**

- Mock Drizzle/Turso clients (not real connections)
- Types auto-inferred from `src/lib/db/schema/`
- ULID primary keys (not UUID)

**Workflow testing:**

- Mock workflow context + AI service calls
- Test: step execution → state management → error handling
- Pass auth (userId/teamId) through context

**Commands:**

```bash
bun test                           # Run all tests
bun test --watch                   # Watch mode
bun test path/to/file.test.ts      # Single file
bun test --coverage                # With coverage
```

---

## Platform & Deployment

**Automatic platform detection:**

```typescript
// src/lib/utils/environment.ts
const platform = getDeploymentPlatform(); // cloudflare | vercel | railway | local
const appUrl = getAppUrl(); // Auto-resolves CF_PAGES_URL/VERCEL_URL/etc.
```

**Supported platforms:**

- **Cloudflare Pages** (recommended) - Edge runtime, R2 native, global CDN
- **Vercel** - Auto-scaling, edge functions
- **Railway** - Simple deploys, preview environments

**CI/CD** (`.github/workflows/`):

- Auto-deploys on push to main
- PR preview deployments
- Unique Turso database per PR

**Environment variables:**

- See `.env.example` for required vars
- Run `bun setup` for local dev defaults
- Production: Set via platform dashboard

---

## Global Rules

From `~/.claude/CLAUDE.md` (applies to all projects):

- Don't cast to `any`
- Don't create fallback code - display errors to user
- Look for repeated code or existing implementations
- Review code to make it concise and less repetitive
- Inline skeleton states (no separate skeleton components)
- Don't generate excessive tests - cover critical paths only
- **Database migrations**: Use Drizzle Kit (`bun db:generate`), never manually write SQL
- Use `type` instead of `interface`
- Throw errors instead of returning success boolean

<!-- intent-skills:start -->

# Skill mappings - load `use` with `bunx @tanstack/intent@latest load <use>`.

skills:

- when: "Use when writing test fixtures for @copilotkit/aimock — mock LLM responses, tool call sequences, error injection, multi-turn agent loops, embeddings, structured output, sequential responses, or debugging fixture mismatches"
  use: "@copilotkit/aimock#write-fixtures"
- when: "Entry point for TanStack AI skills. Routes to chat-experience, tool-calling, media-generation, structured-outputs, adapter-configuration, ag-ui-protocol, middleware, custom-backend-integration, and debug-logging. Use chat() not streamText(), openaiText() not createOpenAI(), toServerSentEventsResponse() not manual SSE, middleware hooks not onEnd callbacks."
  use: "@tanstack/ai#ai-core"
- when: "Provider adapter selection and configuration: openaiText, anthropicText, geminiText, ollamaText, grokText, groqText, openRouterText. Per-model type safety with modelOptions, reasoning/thinking configuration, runtime adapter switching, extendAdapter() for custom models, createModel(). API key env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY/GEMINI_API_KEY, XAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST."
  use: "@tanstack/ai#ai-core/adapter-configuration"
- when: "Server-side AG-UI streaming protocol implementation: StreamChunk event types (RUN_STARTED, TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END, RUN_FINISHED, RUN_ERROR, STEP_STARTED/STEP_FINISHED, STATE_SNAPSHOT/DELTA, CUSTOM), toServerSentEventsStream() for SSE format, toHttpStream() for NDJSON format. For backends serving AG-UI events without client packages."
  use: "@tanstack/ai#ai-core/ag-ui-protocol"
- when: "End-to-end chat implementation: server endpoint with chat() and toServerSentEventsResponse(), client-side useChat hook with fetchServerSentEvents(), message rendering with UIMessage parts, multimodal content, thinking/reasoning display. Covers streaming states, connection adapters, and message format conversions. NOT Vercel AI SDK — uses chat() not streamText()."
  use: "@tanstack/ai#ai-core/chat-experience"
- when: "Connect useChat to a non-TanStack-AI backend through custom connection adapters. ConnectConnectionAdapter (single async iterable) vs SubscribeConnectionAdapter (separate subscribe/send). Customize fetchServerSentEvents() and fetchHttpStream() with auth headers, custom URLs, and request options. Import from framework package, not @tanstack/ai-client."
  use: "@tanstack/ai#ai-core/custom-backend-integration"
- when: "Pluggable, category-toggleable debug logging for TanStack AI activities. Toggle with `debug: true | false | DebugConfig` on chat(), summarize(), generateImage(), generateSpeech(), generateTranscription(), generateVideo(). Categories: request, provider, output, middleware, tools, agentLoop, config, errors. Pipe into pino/winston/etc via `debug: { logger }`. Errors log by default even when `debug` is omitted; silence with `debug: false`."
  use: "@tanstack/ai#ai-core/debug-logging"
- when: "Image, audio, video, speech (TTS), and transcription generation using activity-specific adapters: generateImage() with openaiImage/geminiImage, generateAudio() with geminiAudio/falAudio, generateVideo() with async polling, generateSpeech() with openaiSpeech, generateTranscription() with openaiTranscription. React hooks: useGenerateImage, useGenerateAudio, useGenerateSpeech, useTranscription, useGenerateVideo. TanStack Start server function integration with toServerSentEventsResponse."
  use: "@tanstack/ai#ai-core/media-generation"
- when: "Chat lifecycle middleware hooks: onConfig, onStart, onChunk, onBeforeToolCall, onAfterToolCall, onUsage, onFinish, onAbort, onError. Use for analytics, event firing, tool caching (toolCacheMiddleware), logging, and tracing. Middleware array in chat() config, left-to-right execution order. NOT onEnd/onFinish callbacks on chat() — use middleware."
  use: "@tanstack/ai#ai-core/middleware"
- when: "Type-safe JSON schema responses from LLMs using outputSchema on chat(). Supports Zod, ArkType, and Valibot schemas. The adapter handles provider-specific strategies transparently — never configure structured output at the provider level. Pass stream:true alongside outputSchema for incremental JSON deltas + a terminal validated object via the `structured-output.complete` event. convertSchemaToJsonSchema() for manual schema conversion."
  use: "@tanstack/ai#ai-core/structured-outputs"
- when: "Isomorphic tool system: toolDefinition() with Zod schemas, .server() and .client() implementations, passing tools to both chat() on server and useChat/clientTools on client, tool approval flows with needsApproval and addToolApprovalResponse(), lazy tool discovery with lazy:true, rendering ToolCallPart and ToolResultPart in UI."
  use: "@tanstack/ai#ai-core/tool-calling"
- when: "Install TanStack Devtools, pick framework adapter (React/Vue/Solid/Preact), register plugins via plugins prop, configure shell (position, hotkeys, theme, hideUntilHover, requireUrlFlag, eventBusConfig). TanStackDevtools component, defaultOpen, localStorage persistence."
  use: "@tanstack/devtools#devtools-app-setup"
- when: "Publish plugin to npm and submit to TanStack Devtools Marketplace. PluginMetadata registry format, plugin-registry.ts, pluginImport (importName, type), requires (packageName, minVersion), framework tagging, multi-framework submissions, featured plugins."
  use: "@tanstack/devtools#devtools-marketplace"
- when: "Build devtools panel components that display emitted event data. Listen via EventClient.on(), handle theme (light/dark), use @tanstack/devtools-ui components. Plugin registration (name, render, id, defaultOpen), lifecycle (mount, activate, destroy), max 3 active plugins. Two paths: Solid.js core with devtools-ui for multi-framework support, or framework-specific panels."
  use: "@tanstack/devtools#devtools-plugin-panel"
- when: "Handle devtools in production vs development. removeDevtoolsOnBuild, devDependency vs regular dependency, conditional imports, NoOp plugin variants for tree-shaking, non-Vite production exclusion patterns."
  use: "@tanstack/devtools#devtools-production"
- when: "Two-way event patterns between devtools panel and application. App-to-devtools observation, devtools-to-app commands, time-travel debugging with snapshots and revert. structuredClone for snapshot safety, distinct event suffixes for observation vs commands, serializable payloads only."
  use: "@tanstack/devtools-event-client#devtools-bidirectional"
- when: "Create typed EventClient for a library. Define event maps with typed payloads, pluginId auto-prepend namespacing, emit()/on()/onAll()/onAllPluginEvents() API. Connection lifecycle (5 retries, 300ms), event queuing, enabled/disabled state, SSR fallbacks, singleton pattern. Unique pluginId requirement to avoid event collisions."
  use: "@tanstack/devtools-event-client#devtools-event-client"
- when: "Analyze library codebase for critical architecture and debugging points, add strategic event emissions. Identify middleware boundaries, state transitions, lifecycle hooks. Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload fields, guard emit() for production. Transparent server/client event bridging."
  use: "@tanstack/devtools-event-client#devtools-instrumentation"
- when: "Use devtools-utils factory functions to create per-framework plugin adapters. createReactPlugin/createSolidPlugin/createVuePlugin/createPreactPlugin, createReactPanel/createSolidPanel/createVuePanel/createPreactPanel. [Plugin, NoOpPlugin] tuple for tree-shaking. DevtoolsPanelProps (theme). Vue uses (name, component) not options object. Solid render must be function."
  use: "@tanstack/devtools-utils#devtools-framework-adapters"
- when: "Configure @tanstack/devtools-vite for source inspection (data-tsd-source, inspectHotkey, ignore patterns), console piping (client-to-server, server-to-client, levels), enhanced logging, server event bus (port, host, HTTPS), production stripping (removeDevtoolsOnBuild), editor integration (launch-editor, custom editor.open). Must be FIRST plugin in Vite config. Vite ^6 || ^7 only."
  use: "@tanstack/devtools-vite#devtools-vite-plugin"
- when: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
  use: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
- when: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
  use: "@tanstack/react-start#react-start"
- when: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
  use: "@tanstack/react-start#react-start/server-components"
- when: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
  use: "@tanstack/router-core#router-core"
- when: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (\_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
  use: "@tanstack/router-core#router-core/auth-and-guards"
- when: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
  use: "@tanstack/router-core#router-core/code-splitting"
- when: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
  use: "@tanstack/router-core#router-core/data-loading"
- when: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
  use: "@tanstack/router-core#router-core/navigation"
- when: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
  use: "@tanstack/router-core#router-core/not-found-and-errors"
- when: "Dynamic path segments ($paramName), splat routes ($ / \_splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
  use: "@tanstack/router-core#router-core/path-params"
- when: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
  use: "@tanstack/router-core#router-core/search-params"
- when: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
  use: "@tanstack/router-core#router-core/ssr"
- when: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
  use: "@tanstack/router-core#router-core/type-safety"
- when: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
  use: "@tanstack/router-plugin#router-plugin"
- when: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
  use: "@tanstack/start-client-core#start-core"
- when: "Server-side authentication primitives for TanStack Start: session cookies (HttpOnly, Secure, SameSite, \_\_Host- prefix), session read/issue/destroy via createServerFn and middleware, OAuth authorization-code flow with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs, rate limiting auth endpoints, session rotation on privilege change. Pairs with router-core/auth-and-guards for the routing side."
  use: "@tanstack/start-client-core#start-core/auth-server-primitives"
- when: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
  use: "@tanstack/start-client-core#start-core/deployment"
- when: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE\_ prefix, process.env)."
  use: "@tanstack/start-client-core#start-core/execution-model"
- when: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
  use: "@tanstack/start-client-core#start-core/middleware"
- when: "createServerFn (GET/POST), inputValidator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
  use: "@tanstack/start-client-core#start-core/server-functions"
- when: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
  use: "@tanstack/start-client-core#start-core/server-routes"
- when: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
  use: "@tanstack/start-server-core#start-server-core"
- when: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."
  use: "@tanstack/virtual-file-routes#virtual-file-routes"
- when: "Load environment variables from a .env file into process.env for Node.js applications. Use when configuring apps with secrets, setting up local development environments, managing API keys and database uRLs, parsing .env file contents, or populating environment variables programmatically. Always use this skill when the user mentions .env, even for simple tasks like \"set up dotenv\" — the skill contains critical gotchas (encrypted keys, variable expansion, command substitution) that prevent common production issues."
  use: "dotenv#dotenv"
- when: "Use dotenvx to run commands with environment variables, manage multiple .env files, expand variables, and encrypt env files for safe commits and CI/CD."
use: "dotenv#dotenvx"
<!-- intent-skills:end -->
