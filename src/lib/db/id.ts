/**
 * ID Generation Utilities
 * Centralized ID generation for all database entities using ULIDs
 */

import { ulid } from 'ulid';

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 *
 * Format: 01ARZ3NDEKTSV4RRFFQ69G5FAV (26 characters)
 *
 * Benefits over UUID v4:
 * - Lexicographically sortable (better index performance)
 * - Timestamp prefix (can extract creation time)
 * - Shorter (26 vs 36 characters)
 * - Still globally unique
 *
 * @returns ULID string
 *
 * @example
 * ```ts
 * const id = generateId();
 * // "01HF5Z8XKQYC5N8Z3KQXR6TBQM"
 * ```
 */
export function generateId(): string {
  return ulid();
}

/**
 * Generate a ULID with a specific timestamp
 * Useful for testing or backfilling data
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns ULID string with specified timestamp
 *
 * @example
 * ```ts
 * const id = generateIdAt(Date.now());
 * ```
 */
export function generateIdAt(timestamp: number): string {
  return ulid(timestamp);
}

/**
 * Extract timestamp from a ULID
 *
 * @param id - ULID string
 * @returns Unix timestamp in milliseconds
 *
 * @example
 * ```ts
 * const id = generateId();
 * const timestamp = getTimestampFromId(id);
 * console.log(new Date(timestamp)); // Creation time
 * ```
 */
export function getTimestampFromId(id: string): number {
  // ULID spec: first 10 characters encode timestamp
  const timeComponent = id.substring(0, 10);

  // Decode Crockford's Base32
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = 0;

  for (let i = 0; i < timeComponent.length; i++) {
    const char = timeComponent[i];
    if (char === undefined) {
      throw new Error(`Invalid ULID: character at index ${i} is undefined`);
    }
    value = value * 32 + chars.indexOf(char);
  }

  return value;
}

/**
 * Validate if a string is a valid ULID
 *
 * @param id - String to validate
 * @returns true if valid ULID
 *
 * @example
 * ```ts
 * isValidId('01ARZ3NDEKTSV4RRFFQ69G5FAV'); // true
 * isValidId('invalid'); // false
 * ```
 */
export function isValidId(id: string): boolean {
  // ULID is exactly 26 characters, Crockford's Base32 alphabet
  const ulidRegex = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  return ulidRegex.test(id);
}
