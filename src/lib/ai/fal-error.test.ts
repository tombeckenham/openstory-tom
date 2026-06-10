import { describe, expect, it } from 'vitest';
import { extractFalErrorMessage } from './fal-error';

function withBody(body: unknown, status = 422): Error {
  const err = new Error('Unprocessable Entity') as Error & {
    body?: unknown;
    status?: number;
  };
  err.body = body;
  err.status = status;
  return err;
}

describe('extractFalErrorMessage', () => {
  it('reads the FastAPI/Pydantic string detail (prod fal shape)', () => {
    expect(
      extractFalErrorMessage(
        withBody({ detail: 'material flagged by a content checker.' })
      )
    ).toBe('material flagged by a content checker.');
  });

  it('joins array detail messages', () => {
    expect(
      extractFalErrorMessage(
        withBody({ detail: [{ msg: 'too long' }, { msg: 'bad seed' }] })
      )
    ).toBe('too long; bad seed');
  });

  it('reads OpenAI-style { error: { message } } (aimock e2e shape)', () => {
    expect(
      extractFalErrorMessage(
        withBody({
          error: { message: 'Output audio has sensitive content.' },
        })
      )
    ).toBe('Output audio has sensitive content.');
  });

  it('reads a string { error } body', () => {
    expect(extractFalErrorMessage(withBody({ error: 'unsafe content' }))).toBe(
      'unsafe content'
    );
  });

  it('reads a top-level { message } body', () => {
    expect(extractFalErrorMessage(withBody({ message: 'boom' }))).toBe('boom');
  });

  it('falls back to error.message when no structured body is present', () => {
    expect(extractFalErrorMessage(new Error('plain failure'))).toBe(
      'plain failure'
    );
  });

  it('stringifies non-Error inputs', () => {
    expect(extractFalErrorMessage('just a string')).toBe('just a string');
  });
});
