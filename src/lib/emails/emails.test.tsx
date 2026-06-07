import { render } from '@react-email/components';
import { describe, expect, it } from 'vitest';
import { OtpEmail } from './otp-email';

describe('OtpEmail', () => {
  it('renders HTML containing the code and expiry notice', async () => {
    const html = await render(<OtpEmail appName="OpenStory" otp="482913" />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('482913');
    expect(html).toContain('OpenStory');
    expect(html).toContain('This code expires in 5 minutes');
    // Styles must be inline — Gmail strips <style> blocks.
    expect(html).not.toContain('<style');
  });

  it('renders a plain-text version with the code', async () => {
    const text = await render(<OtpEmail appName="OpenStory" otp="482913" />, {
      plainText: true,
    });

    expect(text).toContain('482913');
    expect(text).not.toContain('<');
  });
});
