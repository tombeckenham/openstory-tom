/**
 * One-time sign-in code email. Server-only — rendered by email-service.tsx.
 */

import { Heading, Section, Text } from '@react-email/components';
import {
  EmailLayout,
  headingClass,
  paragraphClass,
  WarningBox,
} from './email-layout';

interface OtpEmailProps {
  appName: string;
  appUrl: string;
  otp: string;
}

export const OtpEmail: React.FC<OtpEmailProps> = ({ appName, appUrl, otp }) => (
  <EmailLayout
    appName={appName}
    appUrl={appUrl}
    preview={`Your sign-in code is ${otp}`}
  >
    <Section>
      <Heading as="h2" className={headingClass}>
        Your Sign-In Code
      </Heading>
      <Text className={paragraphClass}>
        Enter this code to sign in to your account:
      </Text>

      <Section className="my-6 rounded-lg bg-gray-100 p-6">
        <Text className="m-0 text-center font-mono text-4xl font-bold tracking-[8px] text-gray-900">
          {otp}
        </Text>
      </Section>

      <WarningBox title="This code expires in 5 minutes">
        If you didn't request this code, you can safely ignore this email.
      </WarningBox>
    </Section>
  </EmailLayout>
);
