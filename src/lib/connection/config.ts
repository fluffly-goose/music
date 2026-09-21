/**
 * The shape of a saved connection, plus validation.
 *
 * Deliberately narrow: a project URL, a publishable key, and a bucket name.
 * All three are *public* configuration - they identify a project and grant
 * whatever RLS allows, nothing more. No password, no service-role key, and no
 * session token is ever part of this object. Session persistence is left to
 * the Supabase client, which stores and refreshes its own tokens.
 */

export interface ConnectionConfig {
  url: string;
  publishableKey: string;
  bucket: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Partial<Record<keyof ConnectionConfig, string>>;
  value?: ConnectionConfig;
}

export const DEFAULT_BUCKET = 'music';

/**
 * Supabase currently issues three key shapes:
 *   - legacy anon JWT:   eyJ...  (three dot-separated base64url segments)
 *   - publishable key:   sb_publishable_...
 *   - secret key:        sb_secret_...          <- must never reach a browser
 * The service-role JWT is also a legacy JWT, so it is caught by decoding the
 * payload and checking the role claim rather than by shape alone.
 */
const LEGACY_JWT = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{10,}$/;
const SECRET = /^sb_secret_/;

function decodeJwtRole(key: string): string | null {
  const payload = key.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof json.role === 'string' ? json.role : null;
  } catch {
    return null;
  }
}

/** True for keys that would be catastrophic to store in a browser. */
export function isPrivilegedKey(key: string): boolean {
  const trimmed = key.trim();
  if (SECRET.test(trimmed)) return true;
  if (LEGACY_JWT.test(trimmed)) {
    const role = decodeJwtRole(trimmed);
    return role !== null && role !== 'anon';
  }
  return false;
}

export function normalizeUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export function validateConfig(input: Partial<ConnectionConfig>): ValidationResult {
  const errors: ValidationResult['errors'] = {};

  const url = normalizeUrl(input.url ?? '');
  const publishableKey = (input.publishableKey ?? '').trim();
  const bucket = (input.bucket ?? '').trim() || DEFAULT_BUCKET;

  if (!url) {
    errors.url = 'Enter your Supabase project URL.';
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      errors.url = 'That is not a valid URL. It should look like https://your-project.supabase.co';
    }
    if (parsed && parsed.protocol !== 'https:') {
      // http:// would send the key in the clear, and Safari blocks mixed content anyway.
      errors.url = 'The project URL must start with https://';
    }
  }

  if (!publishableKey) {
    errors.publishableKey = 'Enter your publishable (anon) key.';
  } else if (isPrivilegedKey(publishableKey)) {
    errors.publishableKey =
      'That looks like a secret or service-role key. Never put one in a browser - use the publishable (anon) key instead.';
  } else if (!LEGACY_JWT.test(publishableKey) && !PUBLISHABLE.test(publishableKey)) {
    errors.publishableKey = 'That does not look like a Supabase publishable or anon key.';
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bucket)) {
    errors.bucket = 'Bucket names may only contain letters, numbers, dots, dashes and underscores.';
  }

  const ok = Object.keys(errors).length === 0;
  return ok ? { ok, errors, value: { url, publishableKey, bucket } } : { ok, errors };
}

/** Human-readable project ref pulled out of the URL, for display only. */
export function projectRef(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.split('.')[0] ?? host;
  } catch {
    return url;
  }
}
