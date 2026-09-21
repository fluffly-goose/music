/**
 * The single place a SupabaseClient is created.
 *
 * Nothing else in the app calls createClient or touches a key. Screens ask the
 * manager for a client; if there isn't one, they render onboarding. That is
 * what keeps credentials from leaking across the codebase and what makes the
 * whole frontend portable to anyone else's project.
 */

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { ConnectionConfig } from './config';
import { validateConfig, projectRef } from './config';
import {
  AUTH_STORAGE_KEY,
  allowAnonymous,
  clearAll,
  clearConnection,
  loadConnection,
  saveConnection,
  setAllowAnonymous,
} from './storage';
import { AppError, toAppError } from '../utils/errors';
import { createStore, type Store } from '../state/store';

export type ConnectionStatus =
  | 'idle'           // nothing configured yet -> onboarding
  | 'connecting'
  | 'connected'      // client exists and the schema answered
  | 'needs-auth'     // client is fine, but RLS wants a signed-in user
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  config: ConnectionConfig | null;
  session: Session | null;
  remembered: boolean;
  error: AppError | null;
}

export interface TestResult {
  ok: boolean;
  reachable: boolean;
  schemaReady: boolean;
  bucketReady: boolean;
  authenticated: boolean;
  trackCount: number | null;
  error?: AppError;
}

const initialState: ConnectionState = {
  status: 'idle',
  config: null,
  session: null,
  remembered: false,
  error: null,
};

class ConnectionManager {
  readonly store: Store<ConnectionState> = createStore<ConnectionState>({ ...initialState });

  private client: SupabaseClient | null = null;
  private authSubscription: { unsubscribe: () => void } | null = null;
  private restorePromise: Promise<ConnectionState> | null = null;

  /** The live client, or null when not connected. */
  getClient(): SupabaseClient | null {
    return this.client;
  }

  /** Same, but throws the error the UI should display. Use in services. */
  requireClient(): SupabaseClient {
    if (!this.client) {
      throw new AppError('invalid-config', 'Not connected to a Supabase project yet.', {
        hint: 'Add your project URL and publishable key in Settings.',
      });
    }
    return this.client;
  }

  getState(): ConnectionState {
    return this.store.get();
  }

  getBucket(): string {
    return this.store.get().config?.bucket ?? 'music';
  }

  /** The signed-in user's id, used to scope inserts and storage paths. */
  getOwnerId(): string | null {
    return this.store.get().session?.user?.id ?? null;
  }

  /**
   * Builds a client without registering it. Used by the connection test so a
   * bad set of credentials never replaces a working connection.
   */
  private buildClient(config: ConnectionConfig): SupabaseClient {
    return createClient(config.url, config.publishableKey, {
      auth: {
        // The Supabase client owns token storage and refresh. We deliberately
        // do not persist tokens ourselves.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
      },
      global: {
        headers: { 'x-client-info': 'resonance/1.0' },
      },
    });
  }

  /**
   * Probes a candidate project: can we reach it, does the schema exist, is the
   * bucket there, are we authenticated? Reports each answer separately so the
   * onboarding screen can tell the user precisely what is missing.
   */
  async test(input: Partial<ConnectionConfig>): Promise<TestResult> {
    const validation = validateConfig(input);
    if (!validation.ok) {
      const first = Object.values(validation.errors)[0] ?? 'Those details are not valid.';
      return {
        ok: false,
        reachable: false,
        schemaReady: false,
        bucketReady: false,
        authenticated: false,
        trackCount: null,
        error: new AppError('invalid-config', first),
      };
    }

    const config = validation.value!;
    const probe = this.buildClient(config);

    const result: TestResult = {
      ok: false,
      reachable: false,
      schemaReady: false,
      bucketReady: false,
      authenticated: false,
      trackCount: null,
    };

    try {
      const { data: sessionData } = await probe.auth.getSession();
      result.authenticated = Boolean(sessionData.session);

      // head+count is the cheapest query that still proves the table exists
      // and that RLS lets us read it.
      const { count, error } = await probe
        .from('tracks')
        .select('id', { count: 'exact', head: true });

      if (error) {
        const mapped = toAppError(error, 'Reading tracks');
        result.reachable = mapped.kind !== 'network';
        if (mapped.kind === 'missing-tables') {
          result.error = mapped;
          return result;
        }
        if (mapped.kind === 'auth-required' || mapped.kind === 'forbidden') {
          // Tables are there; RLS is simply doing its job.
          result.schemaReady = true;
          result.error = mapped;
        } else {
          result.error = mapped;
          return result;
        }
      } else {
        result.reachable = true;
        result.schemaReady = true;
        result.trackCount = count ?? 0;
      }

      // A private bucket answers list() for an authenticated owner and 400/404
      // when it genuinely is not there.
      const { error: bucketError } = await probe.storage.from(config.bucket).list('', { limit: 1 });
      if (bucketError) {
        const mapped = toAppError(bucketError, 'Checking bucket');
        result.bucketReady = mapped.kind === 'forbidden' || mapped.kind === 'auth-required';
        if (!result.bucketReady && !result.error) result.error = mapped;
      } else {
        result.bucketReady = true;
      }

      result.ok = result.schemaReady && result.bucketReady && !result.error;
      return result;
    } catch (raw) {
      result.error = toAppError(raw, 'Connecting');
      return result;
    }
  }

  /**
   * Makes a config the active connection.
   * `remember` is explicit and off by default - persisting is the user's call.
   */
  async connect(
    input: Partial<ConnectionConfig>,
    options: { remember?: boolean } = {},
  ): Promise<ConnectionState> {
    const validation = validateConfig(input);
    if (!validation.ok) {
      const first = Object.values(validation.errors)[0] ?? 'Those details are not valid.';
      const error = new AppError('invalid-config', first);
      this.store.set({ status: 'error', error });
      return this.store.get();
    }

    const config = validation.value!;
    this.store.set({ status: 'connecting', error: null, config });

    this.teardownClient();
    this.client = this.buildClient(config);

    let session: Session | null = null;
    try {
      const { data } = await this.client.auth.getSession();
      session = data.session ?? null;
    } catch {
      session = null;
    }

    this.watchAuth();

    const remembered = options.remember === true ? saveConnection(config) : false;
    if (options.remember === false) clearConnection();

    // Ask the database whether this session can actually read anything. That
    // distinction - connected vs needs-auth - drives the whole app shell.
    //
    // The subtle part: Row Level Security *filters* rows on SELECT, it does
    // not raise. A correctly-secured project therefore answers an anonymous
    // client with `200 []`, which looks identical to an empty library. Going
    // on the absence of an error alone would strand a signed-out user in a
    // library that appears empty, with nothing prompting them to sign in.
    let status: ConnectionStatus = 'connected';
    let error: AppError | null = null;
    try {
      const { count, error: probeError } = await this.client
        .from('tracks')
        .select('id', { count: 'exact', head: true });

      if (probeError) {
        const mapped = toAppError(probeError, 'Reading tracks');
        if (mapped.kind === 'auth-required' || mapped.kind === 'forbidden') {
          status = 'needs-auth';
        } else {
          status = 'error';
          error = mapped;
        }
      } else if (!session && !allowAnonymous()) {
        // No session and no error. Either the library is genuinely readable
        // anonymously, or RLS is quietly hiding all of it.
        //   rows visible  -> anonymous reads really are allowed
        //   nothing visible -> assume RLS, and offer sign-in
        // The user can still override this from the sign-in screen, and that
        // choice is remembered.
        status = (count ?? 0) > 0 ? 'connected' : 'needs-auth';
      }
    } catch (raw) {
      status = 'error';
      error = toAppError(raw, 'Connecting');
    }

    this.store.set({ status, config, session, remembered, error });
    return this.store.get();
  }

  /**
   * Called once on boot. Restores a remembered connection so the user lands
   * straight in their library. Concurrent callers share one promise.
   */
  restore(): Promise<ConnectionState> {
    if (this.restorePromise) return this.restorePromise;

    this.restorePromise = (async () => {
      const config = loadConnection();
      if (!config) {
        this.store.set({ status: 'idle', config: null, remembered: false });
        return this.store.get();
      }
      return this.connect(config, { remember: true });
    })();

    return this.restorePromise;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const client = this.requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new AppError('auth-failed', error.message || 'Could not sign in.', {
        hint: 'Check the email and password, or create the user in Supabase Dashboard -> Authentication.',
        cause: error,
      });
    }
    setAllowAnonymous(false);
    this.store.set({ session: data.session, status: 'connected', error: null });
    return data.session!;
  }

  async signUp(email: string, password: string): Promise<Session | null> {
    const client = this.requireClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) {
      throw new AppError('auth-failed', error.message || 'Could not create that account.', {
        cause: error,
      });
    }
    if (data.session) this.store.set({ session: data.session, status: 'connected', error: null });
    return data.session;
  }

  /**
   * "Continue without signing in", for a library whose RLS deliberately allows
   * anonymous reads. Remembered, so it is not asked again on every visit.
   */
  continueAnonymously(): void {
    setAllowAnonymous(true);
    this.store.set({ status: 'connected', error: null });
  }

  async signOut(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.auth.signOut();
    } catch {
      /* signing out locally is what matters */
    }
    setAllowAnonymous(false);
    this.store.set({ session: null, status: 'needs-auth' });
  }

  /**
   * Full reset. `forget` also wipes the saved config and tokens, which is what
   * the "Disconnect and clear saved settings" button in Settings calls.
   */
  async disconnect(options: { forget?: boolean } = {}): Promise<void> {
    if (this.client && options.forget) {
      try {
        await this.client.auth.signOut();
      } catch {
        /* best effort */
      }
    }
    this.teardownClient();
    if (options.forget) clearAll();
    this.restorePromise = null;
    this.store.set({ ...initialState });
  }

  private teardownClient(): void {
    this.authSubscription?.unsubscribe();
    this.authSubscription = null;
    this.client = null;
  }

  /**
   * Mirrors Supabase auth events into our state. TOKEN_REFRESHED matters most:
   * it is what keeps long listening sessions from silently 401-ing.
   */
  private watchAuth(): void {
    if (!this.client) return;
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        this.store.set({ session: null, status: 'needs-auth' });
        return;
      }
      if (session) {
        const status = this.store.get().status;
        this.store.set({
          session,
          status: status === 'needs-auth' || status === 'error' ? 'connected' : status,
          error: status === 'error' ? null : this.store.get().error,
        });
      }
    });
    this.authSubscription = data.subscription;
  }

  /** What the Settings screen shows under "what is being saved". */
  describeSaved(): { key: string; label: string; value: string }[] {
    const config = this.store.get().config;
    if (!config) return [];
    return [
      { key: 'url', label: 'Project URL', value: config.url },
      { key: 'ref', label: 'Project ref', value: projectRef(config.url) },
      {
        key: 'key',
        label: 'Publishable key',
        value: `${config.publishableKey.slice(0, 12)}…${config.publishableKey.slice(-4)}`,
      },
      { key: 'bucket', label: 'Music bucket', value: config.bucket },
    ];
  }
}

export const connection = new ConnectionManager();
