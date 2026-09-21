import { describe, it, expect, beforeEach } from 'vitest';
import { validateConfig, isPrivilegedKey, normalizeUrl, projectRef, DEFAULT_BUCKET } from '@/lib/connection/config';
import {
  saveConnection, loadConnection, clearConnection, clearAll,
  loadPreferences, savePreferences, CONFIG_KEY, DEFAULT_PREFERENCES,
} from '@/lib/connection/storage';

/** A syntactically valid legacy anon JWT: header.payload.signature, role=anon. */
function makeJwt(role: string): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.sig_placeholder`;
}

const ANON_KEY = makeJwt('anon');
const SERVICE_KEY = makeJwt('service_role');

describe('config validation', () => {
  it('accepts a well-formed connection', () => {
    const result = validateConfig({
      url: 'https://abcdefg.supabase.co', publishableKey: ANON_KEY, bucket: 'music',
    });
    expect(result.ok).toBe(true);
    expect(result.value?.bucket).toBe('music');
  });

  it('accepts the newer sb_publishable_ key format', () => {
    const result = validateConfig({
      url: 'https://abcdefg.supabase.co',
      publishableKey: 'sb_publishable_AbCdEfGhIjKlMnOp123',
    });
    expect(result.ok).toBe(true);
  });

  it('defaults the bucket when none is given', () => {
    const result = validateConfig({ url: 'https://a.supabase.co', publishableKey: ANON_KEY });
    expect(result.value?.bucket).toBe(DEFAULT_BUCKET);
  });

  it('strips trailing slashes from the URL', () => {
    const result = validateConfig({ url: 'https://a.supabase.co///', publishableKey: ANON_KEY });
    expect(result.value?.url).toBe('https://a.supabase.co');
  });

  it('rejects a missing URL and a missing key', () => {
    const result = validateConfig({});
    expect(result.ok).toBe(false);
    expect(result.errors.url).toBeDefined();
    expect(result.errors.publishableKey).toBeDefined();
  });

  it('rejects non-https URLs, which would leak the key in transit', () => {
    const result = validateConfig({ url: 'http://a.supabase.co', publishableKey: ANON_KEY });
    expect(result.ok).toBe(false);
    expect(result.errors.url).toMatch(/https/);
  });

  it('rejects an unparseable URL', () => {
    expect(validateConfig({ url: 'not a url', publishableKey: ANON_KEY }).ok).toBe(false);
  });

  it('rejects garbage that is not a Supabase key at all', () => {
    const result = validateConfig({ url: 'https://a.supabase.co', publishableKey: 'hunter2' });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid bucket name', () => {
    const result = validateConfig({
      url: 'https://a.supabase.co', publishableKey: ANON_KEY, bucket: 'my bucket/../etc',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.bucket).toBeDefined();
  });
});

describe('privileged key detection', () => {
  it('flags a service-role JWT', () => {
    expect(isPrivilegedKey(SERVICE_KEY)).toBe(true);
  });

  it('flags an sb_secret_ key', () => {
    expect(isPrivilegedKey('sb_secret_abcdefghijklmnop')).toBe(true);
  });

  it('does not flag a legitimate anon key', () => {
    expect(isPrivilegedKey(ANON_KEY)).toBe(false);
  });

  it('does not flag a publishable key', () => {
    expect(isPrivilegedKey('sb_publishable_abcdefghijklmnop')).toBe(false);
  });

  it('refuses to save a service-role key, with an explicit warning', () => {
    const result = validateConfig({ url: 'https://a.supabase.co', publishableKey: SERVICE_KEY });
    expect(result.ok).toBe(false);
    expect(result.errors.publishableKey).toMatch(/service-role|secret/i);
  });
});

describe('connection persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a saved connection', () => {
    const config = { url: 'https://abc.supabase.co', publishableKey: ANON_KEY, bucket: 'music' };
    expect(saveConnection(config)).toBe(true);
    expect(loadConnection()).toEqual(config);
  });

  it('returns null when nothing was saved', () => {
    expect(loadConnection()).toBeNull();
  });

  it('returns null rather than throwing on corrupted JSON', () => {
    localStorage.setItem(CONFIG_KEY, '{not json');
    expect(loadConnection()).toBeNull();
  });

  it('rejects a persisted value that no longer validates', () => {
    // e.g. hand-edited, or written by an older build
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ version: 1, url: 'http://insecure', publishableKey: ANON_KEY }));
    expect(loadConnection()).toBeNull();
  });

  it('never persists anything resembling a privileged key', () => {
    saveConnection({ url: 'https://abc.supabase.co', publishableKey: ANON_KEY, bucket: 'music' });
    const raw = localStorage.getItem(CONFIG_KEY)!;
    expect(raw).not.toContain('service_role');
    expect(raw).not.toContain('sb_secret_');
    expect(raw).not.toContain('password');
  });

  it('clearConnection removes the config', () => {
    saveConnection({ url: 'https://abc.supabase.co', publishableKey: ANON_KEY, bucket: 'music' });
    clearConnection();
    expect(loadConnection()).toBeNull();
  });

  it('clearAll also removes persisted Supabase auth tokens', () => {
    saveConnection({ url: 'https://abc.supabase.co', publishableKey: ANON_KEY, bucket: 'music' });
    localStorage.setItem('resonance:auth', 'token-data');
    localStorage.setItem('sb-abc-auth-token', 'token-data');
    clearAll();
    expect(loadConnection()).toBeNull();
    expect(localStorage.getItem('resonance:auth')).toBeNull();
    expect(localStorage.getItem('sb-abc-auth-token')).toBeNull();
  });
});

describe('preferences', () => {
  beforeEach(() => localStorage.clear());

  it('falls back to defaults when unset', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips preferences', () => {
    savePreferences({ volume: 0.4, shuffle: true, repeat: 'all', theme: 'midnight' });
    expect(loadPreferences()).toEqual({ volume: 0.4, shuffle: true, repeat: 'all', theme: 'midnight' });
  });

  it('sanitises out-of-range and bogus values', () => {
    localStorage.setItem('resonance:preferences', JSON.stringify({ volume: 99, repeat: 'sideways', theme: 'neon' }));
    const prefs = loadPreferences();
    expect(prefs.volume).toBe(DEFAULT_PREFERENCES.volume);
    expect(prefs.repeat).toBe('off');
    expect(prefs.theme).toBe('dark');
  });
});

describe('url helpers', () => {
  it('normalizes trailing slashes and whitespace', () => {
    expect(normalizeUrl('  https://a.supabase.co/  ')).toBe('https://a.supabase.co');
  });

  it('extracts the project ref for display', () => {
    expect(projectRef('https://abcdefghij.supabase.co')).toBe('abcdefghij');
  });
});
