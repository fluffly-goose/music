/**
 * Persistence for the connection config.
 *
 * localStorage, not cookies: this value is only ever read by client-side JS on
 * the same origin, so sending it to a server on every request would be pure
 * downside. The Supabase *session* is a separate concern and is persisted by
 * the Supabase client itself under its own key, with automatic refresh.
 */

import type { ConnectionConfig } from './config';
import { DEFAULT_BUCKET, validateConfig } from './config';

export const CONFIG_KEY = 'resonance:connection';
export const PREFS_KEY = 'resonance:preferences';
/** Namespace for the Supabase client's own token storage. */
export const AUTH_STORAGE_KEY = 'resonance:auth';

interface StoredConfig extends ConnectionConfig {
  version: 1;
  savedAt: string;
}

function safeLocalStorage(): Storage | null {
  try {
    // Safari in Private Browsing used to throw on access; it now throws on
    // write instead. Probe both so we fail early rather than mid-save.
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = '__resonance_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export function storageAvailable(): boolean {
  return safeLocalStorage() !== null;
}

export function saveConnection(config: ConnectionConfig): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  const payload: StoredConfig = { version: 1, savedAt: new Date().toISOString(), ...config };
  try {
    ls.setItem(CONFIG_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function loadConnection(): ConnectionConfig | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  const raw = ls.getItem(CONFIG_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    // Re-validate on read. A saved value can be stale, hand-edited, or written
    // by an older version of the app, and we would rather show the onboarding
    // screen than construct a client from junk.
    const result = validateConfig({
      url: parsed.url,
      publishableKey: parsed.publishableKey,
      bucket: parsed.bucket ?? DEFAULT_BUCKET,
    });
    return result.ok ? result.value! : null;
  } catch {
    return null;
  }
}

/** Forgets the saved config. Does not touch the Supabase session. */
export function clearConnection(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(CONFIG_KEY);
  } catch {
    /* nothing useful to do */
  }
}

/** Forgets the config *and* any persisted Supabase auth tokens. */
export function clearAll(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(CONFIG_KEY);
    for (const key of Object.keys(ls)) {
      if (key.startsWith(AUTH_STORAGE_KEY) || key.startsWith('sb-')) ls.removeItem(key);
    }
  } catch {
    /* nothing useful to do */
  }
}

export interface Preferences {
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  theme: 'dark' | 'midnight' | 'system';
}

export const DEFAULT_PREFERENCES: Preferences = {
  volume: 1,
  shuffle: false,
  repeat: 'off',
  theme: 'dark',
};

export function loadPreferences(): Preferences {
  const ls = safeLocalStorage();
  if (!ls) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = ls.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      volume:
        typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1
          ? parsed.volume
          : DEFAULT_PREFERENCES.volume,
      shuffle: typeof parsed.shuffle === 'boolean' ? parsed.shuffle : false,
      repeat:
        parsed.repeat === 'all' || parsed.repeat === 'one' || parsed.repeat === 'off'
          ? parsed.repeat
          : 'off',
      theme:
        parsed.theme === 'midnight' || parsed.theme === 'system' || parsed.theme === 'dark'
          ? parsed.theme
          : 'dark',
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(prefs: Preferences): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* preferences are best-effort */
  }
}
