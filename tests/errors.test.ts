import { describe, it, expect } from 'vitest';
import { AppError, toAppError, isAuthError } from '@/lib/utils/errors';

describe('error mapping', () => {
  it('passes an AppError straight through', () => {
    const original = new AppError('playback', 'Nope');
    expect(toAppError(original)).toBe(original);
  });

  it('recognises a missing table and tells the user to run the migrations', () => {
    const mapped = toAppError({ code: '42P01', message: 'relation "public.tracks" does not exist' });
    expect(mapped.kind).toBe('missing-tables');
    expect(mapped.hint).toMatch(/migrations/i);
  });

  it('recognises an expired JWT as needing re-auth', () => {
    const mapped = toAppError({ message: 'JWT expired', status: 401 });
    expect(mapped.kind).toBe('auth-required');
    expect(isAuthError(mapped)).toBe(true);
  });

  it('recognises an RLS refusal as forbidden, and points at the policies', () => {
    const mapped = toAppError({ code: '42501', message: 'permission denied for table tracks' });
    expect(mapped.kind).toBe('forbidden');
    expect(mapped.hint).toMatch(/Row Level Security|0002_rls/i);
  });

  it('distinguishes a missing bucket from a missing object', () => {
    expect(toAppError({ message: 'Bucket not found' }).kind).toBe('missing-bucket');
    expect(toAppError({ message: 'Object not found', status: 404 }).kind).toBe('missing-file');
  });

  it('recognises a network failure', () => {
    expect(toAppError(new TypeError('Failed to fetch')).kind).toBe('network');
  });

  it('falls back to unknown while still keeping the message', () => {
    const mapped = toAppError({ message: 'Something odd' }, 'Loading songs');
    expect(mapped.kind).toBe('unknown');
    expect(mapped.userMessage).toContain('Something odd');
    expect(mapped.userMessage).toContain('Loading songs');
  });

  it('never produces an empty user-facing message', () => {
    for (const input of [null, undefined, {}, '', 0, new Error('')]) {
      expect(toAppError(input).userMessage.length).toBeGreaterThan(0);
    }
  });

  it('preserves the underlying cause for debugging', () => {
    const raw = { code: '42P01', message: 'relation does not exist' };
    expect(toAppError(raw).cause).toBe(raw);
  });

  it('does not treat an ordinary error as an auth error', () => {
    expect(isAuthError(toAppError(new Error('boom')))).toBe(false);
  });
});
