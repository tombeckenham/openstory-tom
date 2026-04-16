/**
 * aimock Server for E2E Tests
 *
 * Provides a standalone OpenAI-compatible mock server that intercepts
 * server-side LLM calls (OpenRouter) during E2E tests.
 *
 * Browser-side mocks (fal.ai, R2, QStash) remain in handlers.ts via Playwright routes.
 */

import { LLMock } from '@copilotkit/aimock';

const AIMOCK_PORT = 4010;

let mockServer: LLMock | null = null;

/**
 * Realistic enhanced screenplay response for the enhance script flow.
 * Must be >1000 chars so the short-script nudge dialog doesn't trigger
 * when the user clicks "Generate Sequence" after enhancing.
 */
const ENHANCED_SCRIPT_RESPONSE = `INT. COFFEE SHOP - MORNING

A warm, sun-drenched coffee shop bathed in golden morning light. Steam rises from espresso machines, creating a soft haze that diffuses the sunlight streaming through floor-to-ceiling windows.

WIDE SHOT - The camera slowly pans across the bustling interior, past baristas crafting drinks and customers absorbed in their laptops.

JOHN (30s, disheveled hair, dark circles under tired eyes) hunches over a laptop at a corner table. Empty coffee cups litter the table around him. His fingers fly across the keyboard with increasing frustration.

JOHN
(muttering, rubbing his eyes)
I need to fix this bug before the demo. Three hours and counting...

He stares at the screen, scrolling through lines of code. His phone buzzes - a calendar reminder: "DEMO IN 2 HOURS."

CUT TO:

MEDIUM SHOT - SARAH (30s, confident stride, carrying two steaming cups) weaves through the crowded tables toward John's corner.

SARAH
(warm smile, setting down a cup)
Here's your caffeine fix. How's it going?

JOHN
(looking up, grateful but exhausted)
Three hours in and I think I found the issue. Maybe. Probably not.

SARAH slides into the seat across from him, wrapping her hands around her own cup.

SARAH
Show me. Two sets of eyes are better than one bloodshot pair.

John turns the laptop toward her. She leans forward, scanning the code with practiced efficiency.

CLOSE UP - Sarah's eyes widen as she spots something.

SARAH
(pointing at the screen)
There. Line 247. You're passing the callback before the promise resolves.

JOHN
(leaning in, then slumping back with relief)
That's... that's it. That's the bug. Three hours for one misplaced line.

He quickly makes the fix, hits save, and runs the tests. Green checkmarks cascade down the terminal.

JOHN
(breaking into a grin)
All tests passing. Sarah, you're a lifesaver.

SARAH
(raising her cup)
You owe me lunch. A real one, not vending machine sandwiches.

They clink cups as the morning light bathes the coffee shop in warmth.

FADE OUT.`;

export async function startAimockServer(): Promise<string> {
  // Strict mode: unmatched requests return 503, forcing new LLM calls to add fixtures
  mockServer = new LLMock({ port: AIMOCK_PORT, strict: true });

  // Enhance script — matches the user prompt from createUserPrompt()
  mockServer.onMessage(/enhance|screenplay|script/, {
    content: ENHANCED_SCRIPT_RESPONSE,
  });

  const url = await mockServer.start();
  console.log(`[e2e] aimock server started at ${url}`);
  return url;
}

export async function stopAimockServer(): Promise<void> {
  if (!mockServer) return;
  try {
    await mockServer.stop();
    console.log('[e2e] aimock server stopped');
  } catch {
    // Server may not have started successfully — ignore stop errors
  }
  mockServer = null;
}
