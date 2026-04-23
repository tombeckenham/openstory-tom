import { getEnv } from '#env';
import { AuthenticationError } from '@/lib/errors';

function parseAdminEmails(): string[] {
  const raw = getEnv().ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isSystemAdmin(email: string): boolean {
  return parseAdminEmails().includes(email.toLowerCase());
}

export function getInternalDomains(): string[] {
  const domains = new Set<string>();
  for (const email of parseAdminEmails()) {
    const at = email.lastIndexOf('@');
    if (at > 0 && at < email.length - 1) {
      domains.add(email.slice(at + 1));
    }
  }
  return [...domains];
}

export function requireSystemAdmin(email: string): void {
  if (!isSystemAdmin(email)) {
    throw new AuthenticationError('System admin access required');
  }
}
