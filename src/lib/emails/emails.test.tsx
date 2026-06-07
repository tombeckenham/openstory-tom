import { describe, expect, it } from 'vitest';
import { OtpEmail } from './otp-email';
import { renderEmail } from './render-email';

describe('renderEmail(OtpEmail)', () => {
  it('renders HTML containing the code and expiry notice', async () => {
    const { html } = await renderEmail(
      <OtpEmail appName="OpenStory" otp="482913" />
    );

    // Exactly one doctype — React's stream renderer emits its own, which
    // renderEmail must strip before prepending the XHTML one.
    expect(html.match(/<!DOCTYPE/g)).toHaveLength(1);
    expect(html.startsWith('<!DOCTYPE html PUBLIC')).toBe(true);
    expect(html).toContain('482913');
    expect(html).toContain('OpenStory');
    expect(html).toContain('This code expires in 5 minutes');
    // Styles must be inline — Gmail strips <style> blocks.
    expect(html).not.toContain('<style');
    // The Tailwind wrapper must have compiled classes to inline styles.
    expect(html).toContain('style=');
  });

  it('renders a plain-text version with the code', async () => {
    const { text } = await renderEmail(
      <OtpEmail appName="OpenStory" otp="482913" />
    );

    expect(text).toContain('482913');
    expect(text).not.toContain('<');
  });
});
