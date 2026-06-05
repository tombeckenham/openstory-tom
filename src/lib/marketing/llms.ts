import {
  FAQ_ITEMS,
  OPEN_FAIR_BENEFITS,
  PROCESS_STEPS,
  SITE_CONFIG,
  TOP_TIER_FEATURES,
} from '@/lib/marketing/constants';

/**
 * Markdown overview of OpenStory for LLM/agent consumption. Served verbatim
 * at /llms.txt and as the markdown rendition of the homepage when an agent
 * sends `Accept: text/markdown` (#819).
 */
export function buildLlmsTxt(): string {
  const lines: string[] = [];

  lines.push(`# ${SITE_CONFIG.name}`);
  lines.push('');
  lines.push(`> ${SITE_CONFIG.description}`);
  lines.push('');
  lines.push(
    `${SITE_CONFIG.name} is an open source AI video production platform. Describe an idea or paste a script, and it builds scenes, casts characters, generates shots, and scores music — all from one interface. Multi-scene, fully exportable, and free to self-host.`
  );

  lines.push('');
  lines.push('## How It Works');
  lines.push('');
  for (const step of PROCESS_STEPS) {
    lines.push(`${step.number}. **${step.title}**: ${step.description}`);
  }

  lines.push('');
  lines.push('## Features');
  lines.push('');
  for (const feature of TOP_TIER_FEATURES) {
    lines.push(`- **${feature.title}**: ${feature.description}`);
  }

  lines.push('');
  lines.push('## Open & Fair');
  lines.push('');
  for (const benefit of OPEN_FAIR_BENEFITS) {
    lines.push(`- **${benefit.title}**: ${benefit.description}`);
  }

  lines.push('');
  lines.push('## FAQ');
  lines.push('');
  for (const item of FAQ_ITEMS) {
    lines.push(`### ${item.question}`);
    lines.push('');
    lines.push(item.answer);
    lines.push('');
  }

  lines.push('## Documentation');
  lines.push('');
  lines.push(`- Docs: ${SITE_CONFIG.url}/docs`);
  lines.push(`- Full docs (markdown): ${SITE_CONFIG.url}/docs/llms.md`);
  lines.push('');

  lines.push('## Links');
  lines.push('');
  lines.push(`- Website: ${SITE_CONFIG.url}`);
  lines.push(`- App: ${SITE_CONFIG.url}/sequences/new`);
  lines.push(`- GitHub: ${SITE_CONFIG.githubHref}`);
  lines.push(`- License: ${SITE_CONFIG.githubHref}/blob/main/LICENSE`);
  lines.push('');

  return lines.join('\n');
}

/** Markdown rendition of the FAQ, built from the same FAQ_ITEMS as llms.txt. */
export function buildFaqMarkdown(): string {
  const lines: string[] = ['# Frequently Asked Questions', ''];
  for (const item of FAQ_ITEMS) {
    lines.push(`## ${item.question}`);
    lines.push('');
    lines.push(item.answer);
    lines.push('');
  }
  return lines.join('\n');
}
