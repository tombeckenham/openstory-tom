/**
 * Full Sequence Pipeline E2E Test
 *
 * Drives the complete sequence creation flow with real workflows running
 * against a local QStash, and AI traffic served by aimock (LLM via OpenRouter
 * passthrough, fal.ai via the mounted fal handler).
 *
 * This spec only runs when `PLAYWRIGHT_FULL_PIPELINE=true` is set. Use
 * `bun test:e2e:full` to invoke it. CI runs it in the dedicated
 * `e2e-full-pipeline` job in `.github/workflows/test.yml`.
 *
 * Prerequisites:
 * - QStash docker container running on localhost:8080 (`bun qstash:dev`)
 * - Recorded fixtures in `e2e/fixtures/recorded/` (run
 *   `bun scripts/record-e2e-fixtures.ts` once with real FAL_KEY +
 *   OPENROUTER_KEY to populate)
 */

import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import {
  cleanupSequenceById,
  createTestStyle,
  getTestSequenceFrames,
} from '../fixtures/sequence.fixture';
import {
  getSystemTalentByName,
  type TestTalent,
} from '../fixtures/talent.fixture';
import {
  getSystemLocationByName,
  type TestLibraryLocation,
} from '../fixtures/location.fixture';
import { resolve } from 'node:path';

const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';

testWithUser.describe('Full Sequence Pipeline', () => {
  testWithUser.skip(
    !fullPipeline,
    'Set PLAYWRIGHT_FULL_PIPELINE=true (use `bun test:e2e:full`) to run.'
  );

  // The full pipeline runs many workflow steps end-to-end (script → frames →
  // motion → music). Give it generous headroom even when fixtures are cached.
  testWithUser.setTimeout(600_000);

  let testTalents: TestTalent[] = [];
  let testLocation: TestLibraryLocation | null = null;
  let styleId: string | null = null;
  let createdSequenceId: string | null = null;

  testWithUser.beforeEach(async ({ testUser }) => {
    // Pull seeded system talent + locations rather than fabricating ones
    // with placeholder URLs — workflows need real R2 reference images for
    // character/location matching and sheet rendering. The seed runs in
    // globalSetup (see e2e/global-setup.ts).
    testTalents = [
      await getSystemTalentByName('Sienna Blake'),
      await getSystemTalentByName('Jude Calloway'),
    ];
    testLocation = await getSystemLocationByName('Sunlit Loft Studio');
    styleId = await createTestStyle(testUser.teamId);
  });

  testWithUser.afterEach(async () => {
    if (createdSequenceId && styleId) {
      await cleanupSequenceById(createdSequenceId, styleId);
    }
    // System talent and locations are shared and seeded — never delete them.
    testTalents = [];
    testLocation = null;
    styleId = null;
    createdSequenceId = null;
  });

  testWithUser(
    'creates a sequence and runs every workflow through to motion + music',
    async ({ page }) => {
      // 1. Open the new-sequence page and wait for hydration.
      await page.goto('/sequences/new');
      await expect(
        page.getByRole('grid', { name: 'Style selection' })
      ).toBeVisible({ timeout: 15_000 });

      // 2. Select a style by clicking the first one (also confirms hydration).
      await page
        .getByRole('grid', { name: 'Style selection' })
        .getByRole('button')
        .first()
        .click();

      // 3. Type a short script.
      const script = `
INT. NEWSROOM - NIGHT

A reporter types furiously at a glowing terminal. The clack of keys is
the only sound. Outside, rain streaks the window.

REPORTER
We go live in ten.

A producer rushes in with a printed lede.

PRODUCER
Story just broke. We need this on air now.
      `.trim();
      const scriptTextarea = page.locator('textarea');
      await expect(scriptTextarea).toBeVisible();
      await scriptTextarea.fill(script);

      // 4. Enhance script (LLM streaming via aimock OpenRouter passthrough).
      await expect(
        page.getByRole('button', { name: /Enhance Script/i })
      ).toBeEnabled({ timeout: 10_000 });
      await page.getByRole('button', { name: /Enhance Script/i }).click();
      await expect(page.getByText('Target video duration')).toBeVisible();
      await page.getByRole('button', { name: 'Enhance' }).last().click();
      await expect(page.getByRole('button', { name: /Stop/i })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('button', { name: /Stop/i })).not.toBeVisible(
        { timeout: 60_000 }
      );

      // 5. Pick talent.
      await page
        .locator('main')
        .getByRole('button', { name: 'Talent' })
        .click();
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible({ timeout: 10_000 });
      await page.getByText(testTalents[0].name).click();
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(talentDialog).not.toBeVisible();

      // 6. Pick location.
      await page
        .locator('main')
        .getByRole('button', { name: 'Locations' })
        .click();
      const locationDialog = page.getByRole('dialog');
      await expect(locationDialog).toBeVisible({ timeout: 10_000 });
      if (!testLocation) throw new Error('testLocation not initialised');
      await page.getByText(testLocation.name).click();
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(locationDialog).not.toBeVisible();

      // 7. Upload an element image directly to the file input on the page.
      const fileInput = page.locator('input[type="file"][accept*="image"]');
      await fileInput.setInputFiles(
        resolve(import.meta.dirname, '../fixtures/test-image.jpg')
      );

      // 8. Generate — should kick off the workflow chain and navigate.
      await expect(
        page.getByRole('button', { name: /^Generate$/i })
      ).toBeEnabled({ timeout: 15_000 });
      await page.getByRole('button', { name: /^Generate$/i }).click();
      await page.waitForURL(/\/sequences\/[^/]+\/scenes/, {
        timeout: 30_000,
      });
      const match = page.url().match(/\/sequences\/([^/]+)\/scenes/);
      const sequenceId = match?.[1];
      if (!sequenceId) {
        throw new Error(`Failed to extract sequence id from ${page.url()}`);
      }
      createdSequenceId = sequenceId;

      // 9. Wait for storyboard + frame images to land in the DB.
      await expect
        .poll(
          async () => {
            const frames = await getTestSequenceFrames(sequenceId);
            if (frames.length === 0) return false;
            return frames.every((f) => f.thumbnailStatus === 'completed');
          },
          { timeout: 300_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBe(true);

      // 10. Trigger motion generation. The scene-list footer renders a single
      //     batch-generate button whose label is dynamic — `Writing motion
      //     prompts…` / `Composing music…` / `Generating…` while preparing,
      //     and `Generate {N} / {M} frame(s)` once ready. Match either the
      //     ready label or the in-progress one and wait for it to be enabled.
      const motionButton = page
        .getByRole('button', { name: /Generate \d+ ?\/ ?\d+ frames?/i })
        .first();
      await expect(motionButton).toBeVisible({ timeout: 120_000 });
      await expect(motionButton).toBeEnabled({ timeout: 120_000 });
      await motionButton.click();
      await expect
        .poll(
          async () => {
            const frames = await getTestSequenceFrames(sequenceId);
            if (frames.length === 0) return false;
            return frames.every((f) => Boolean(f.videoUrl));
          },
          { timeout: 300_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBe(true);

      // 11. Wait for music to land on every frame. The "Also generate music"
      //     checkbox in the scene-list footer defaults to true, so step 10's
      //     batch trigger already kicks off music + merge. The dedicated
      //     /music tab is for regenerate / hand-tuning, not the happy path.
      await expect
        .poll(
          async () => {
            const frames = await getTestSequenceFrames(sequenceId);
            if (frames.length === 0) return false;
            return frames.every((f) => Boolean(f.audioUrl));
          },
          { timeout: 300_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBe(true);

      // 12. Final assertion: every frame has thumbnail + video + audio URLs.
      const frames = await getTestSequenceFrames(sequenceId);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(
          frame.thumbnailUrl,
          `frame ${frame.id} missing thumbnail`
        ).toBeTruthy();
        expect(frame.videoUrl, `frame ${frame.id} missing video`).toBeTruthy();
        expect(frame.audioUrl, `frame ${frame.id} missing audio`).toBeTruthy();
      }
    }
  );
});
