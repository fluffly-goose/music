/**
 * Every failure the app can surface is funnelled through `AppError` so the UI
 * can show something specific and actionable instead of "something went wrong".
 */

export type ErrorKind =
  | 'invalid-config'
  | 'network'
  | 'auth-required'
  | 'auth-failed'
  | 'missing-tables'
  | 'missing-bucket'
  | 'forbidden'
  | 'missing-file'
  | 'unsupported-format'
  | 'signed-url'
  | 'playback'
  | 'empty-library'
  | 'upload'
  | 'unknown';

export class AppError extends Error {
  readonly kind: ErrorKind;
  /** Short, plain-language sentence safe to render directly in the UI. */
  readonly userMessage: string;
  /** What the user can actually do about it, when there is something. */
  readonly hint?: string;
  readonly cause?: unknown;

  constructor(
    kind: ErrorKind,
    userMessage: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(userMessage);
    this.name = 'AppError';
    this.kind = kind;
    this.userMessage = userMessage;
    this.hint = options.hint;
    this.cause = options.cause;
  }
}

/** Postgres error codes that Supabase surfaces through PostgREST. */
const PG_UNDEFINED_TABLE = '42P01';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

interface SupabaseLikeError {
  message?: string;
  code?: string;
  status?: number;
  statusCode?: string | number;
  error?: string;
}

/**
 * Turns whatever Supabase / fetch threw into an AppError.
 *
 * The mapping matters more than it looks: a missing table and a blocked RLS
 * policy both arrive as generic failures, but they need completely different
 * advice ("run the migration" vs "sign in").
 */
export function toAppError(raw: unknown, context?: string): AppError {
  if (raw instanceof AppError) return raw;

  const err = (raw ?? {}) as SupabaseLikeError;
  // An empty message would render a blank error state, which is precisely the
  // silent failure we are trying to avoid - always fall back to something.
  const message =
    (typeof err.message === 'string' && err.message.trim()) ||
    (typeof err.error === 'string' && err.error.trim()) ||
    (typeof raw === 'string' && raw.trim()) ||
    'Something went wrong talking to Supabase.';
  const code = err.code;
  const status = Number(err.status ?? err.statusCode ?? 0);
  const prefix = context ? `${context}: ` : '';

  if (code === PG_UNDEFINED_TABLE || /relation .* does not exist/i.test(message)) {
    return new AppError(
      'missing-tables',
      'This Supabase project does not have the music tables yet.',
      {
        hint: 'Run the SQL in supabase/migrations/ (0001, 0002, 0003) in your project\'s SQL Editor, then reconnect.',
        cause: raw,
      },
    );
  }

  if (code === 'PGRST301' || status === 401 || /jwt|token is expired/i.test(message)) {
    return new AppError('auth-required', 'Your session expired.', {
      hint: 'Sign in again to keep listening.',
      cause: raw,
    });
  }

  if (code === PG_INSUFFICIENT_PRIVILEGE || status === 403) {
    return new AppError('forbidden', `${prefix}Access to that data was refused.`, {
      hint: 'Check that Row Level Security policies from 0002_rls.sql are applied and that you are signed in as the library owner.',
      cause: raw,
    });
  }

  if (/bucket not found/i.test(message) || code === 'NoSuchBucket') {
    return new AppError('missing-bucket', 'That storage bucket does not exist.', {
      hint: 'Create it in Supabase Storage (or run 0003_storage.sql) and make sure the name matches your settings.',
      cause: raw,
    });
  }

  if (/object not found|not_found/i.test(message) || status === 404) {
    return new AppError('missing-file', `${prefix}That file is missing from storage.`, {
      hint: 'The database row points at a path that is not in the bucket. Re-import or fix the track\'s audio_path.',
      cause: raw,
    });
  }

  if (
    status === 0 &&
    (/failed to fetch|networkerror|load failed|fetch failed/i.test(message) || raw instanceof TypeError)
  ) {
    return new AppError('network', 'Could not reach Supabase.', {
      hint: 'Check your internet connection and that the project URL is correct.',
      cause: raw,
    });
  }

  return new AppError('unknown', `${prefix}${message}`, { cause: raw });
}

/** True when the error means "the credentials are fine, you just need to sign in". */
export function isAuthError(error: unknown): boolean {
  return error instanceof AppError && (error.kind === 'auth-required' || error.kind === 'forbidden');
}
