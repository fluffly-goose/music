import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

/**
 * How `connect()` decides between "connected" and "needs sign-in".
 *
 * The case that matters: Row Level Security FILTERS rows on SELECT, it does
 * not raise. A correctly-secured project answers an anonymous client with
 * `200 []` — indistinguishable from an empty library unless the session is
 * taken into account. Getting this wrong strands the user in a library that
 * looks empty with no way to sign in.
 */

let probeResult: { count: number | null; error: unknown } = { count: 0, error: null };
let storedSession: Session | null = null;

const createClient = vi.fn(() => ({
  auth: {
    getSession: async () => ({ data: { session: storedSession } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signInWithPassword: async () => ({ data: { session: storedSession }, error: null }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({
    select: () => Promise.resolve(probeResult),
  }),
  storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) },
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: unknown[]) => createClient(...(a as [])) }));

const { connection } = await import('@/lib/connection/manager');
const { setAllowAnonymous } = await import('@/lib/connection/storage');

const jwt = (role: string) =>
  `${btoa(JSON.stringify({ alg: 'HS256' })).replace(/=+$/, '')}.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.sig`;

const CONFIG = {
  url: 'https://demo.supabase.co',
  publishableKey: jwt('anon'),
  bucket: 'music',
};

const SESSION = {
  access_token: 't', refresh_token: 'r', token_type: 'bearer', expires_in: 3600,
  user: { id: 'owner-1', email: 'me@example.com' },
} as unknown as Session;

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  storedSession = null;
  probeResult = { count: 0, error: null };
  await connection.disconnect();
});

describe('connect() status decision', () => {
  it('is connected when a session exists', async () => {
    storedSession = SESSION;
    probeResult = { count: 12, error: null };
    const state = await connection.connect(CONFIG);
    expect(state.status).toBe('connected');
    expect(connection.getOwnerId()).toBe('owner-1');
  });

  it('is connected with a session even when the library is genuinely empty', async () => {
    storedSession = SESSION;
    probeResult = { count: 0, error: null };
    expect((await connection.connect(CONFIG)).status).toBe('connected');
  });

  it('asks for sign-in when signed out and RLS hides every row', async () => {
    // The regression: no error, no rows, no session. Previously read as
    // "connected", leaving the user in an empty library with no sign-in.
    storedSession = null;
    probeResult = { count: 0, error: null };
    const state = await connection.connect(CONFIG);
    expect(state.status).toBe('needs-auth');
  });

  it('stays connected when signed out but rows really are readable', async () => {
    // A library whose policies deliberately allow anonymous reads.
    storedSession = null;
    probeResult = { count: 7, error: null };
    expect((await connection.connect(CONFIG)).status).toBe('connected');
  });

  it('honours a remembered "continue without signing in" choice', async () => {
    setAllowAnonymous(true);
    storedSession = null;
    probeResult = { count: 0, error: null };
    expect((await connection.connect(CONFIG)).status).toBe('connected');
  });

  it('still maps an explicit auth error to needs-auth', async () => {
    probeResult = { count: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    expect((await connection.connect(CONFIG)).status).toBe('needs-auth');
  });

  it('still maps an RLS refusal to needs-auth', async () => {
    probeResult = { count: null, error: { code: '42501', message: 'permission denied' } };
    expect((await connection.connect(CONFIG)).status).toBe('needs-auth');
  });

  it('surfaces a missing schema as an error, not a sign-in prompt', async () => {
    probeResult = { count: null, error: { code: '42P01', message: 'relation "tracks" does not exist' } };
    const state = await connection.connect(CONFIG);
    expect(state.status).toBe('error');
    expect(state.error?.kind).toBe('missing-tables');
  });
});

describe('the anonymous escape hatch', () => {
  it('continueAnonymously connects and is remembered', async () => {
    storedSession = null;
    probeResult = { count: 0, error: null };
    await connection.connect(CONFIG);

    connection.continueAnonymously();
    expect(connection.getState().status).toBe('connected');

    // A later connect must not re-prompt.
    expect((await connection.connect(CONFIG)).status).toBe('connected');
  });

  it('signing out re-arms the prompt', async () => {
    setAllowAnonymous(true);
    storedSession = null;
    probeResult = { count: 0, error: null };
    await connection.connect(CONFIG);

    await connection.signOut();
    expect(connection.getState().status).toBe('needs-auth');
    expect((await connection.connect(CONFIG)).status).toBe('needs-auth');
  });

  it('clearing saved settings forgets the choice too', async () => {
    setAllowAnonymous(true);
    await connection.connect(CONFIG);
    await connection.disconnect({ forget: true });

    storedSession = null;
    probeResult = { count: 0, error: null };
    expect((await connection.connect(CONFIG)).status).toBe('needs-auth');
  });
});
