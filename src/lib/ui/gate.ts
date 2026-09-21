/**
 * The onboarding / sign-in overlay.
 *
 * Three states, driven entirely by ConnectionState:
 *   idle       -> enter project URL, key, bucket
 *   needs-auth -> credentials are good, sign in to pass RLS
 *   error      -> explain precisely what failed and how to fix it
 */

import { connection } from '../connection/manager';
import { DEFAULT_BUCKET } from '../connection/config';
import { storageAvailable } from '../connection/storage';
import { escapeHtml } from '../utils/format';
import { icons } from './icons';
import { showToast } from './render';

const $ = (id: string) => document.getElementById(id);

/**
 * Which form is currently mounted. Re-rendering on every store change would
 * destroy the inputs the user is typing into - so the form is built once per
 * mode and only its error banner is updated afterwards.
 */
let renderedMode: 'connect' | 'signin' | null = null;

export function initGate(): void {
  connection.store.subscribe(() => renderGate(), { immediate: true });
}

export function renderGate(): void {
  const gate = $('connection-gate');
  const body = $('gate-body');
  if (!gate || !body) return;

  const state = connection.getState();
  const root = document.getElementById('app-root');
  const requiresConnection = root?.dataset.requiresConnection !== 'false';

  // Settings stays reachable while disconnected so the user can fix things.
  // 'connecting' counts as gated: dropping the overlay mid-attempt would flash
  // the empty app behind it and discard whatever the user has typed.
  const needsGate =
    requiresConnection &&
    (state.status === 'idle' ||
      state.status === 'connecting' ||
      state.status === 'needs-auth' ||
      state.status === 'error');

  if (!needsGate) {
    gate.classList.add('hidden');
    renderedMode = null;
    return;
  }

  gate.classList.remove('hidden');

  const mode: 'connect' | 'signin' = state.status === 'needs-auth' ? 'signin' : 'connect';

  // Same form already on screen: refresh only the error banner, so whatever the
  // user has typed survives a failed connection attempt.
  if (mode === renderedMode && body.firstElementChild) {
    if (mode === 'connect') updateErrorBanner(state.error?.userMessage, state.error?.hint);
    return;
  }

  renderedMode = mode;
  if (mode === 'signin') {
    body.innerHTML = signInForm();
    bindSignIn();
  } else {
    body.innerHTML = connectForm(state.error?.userMessage, state.error?.hint);
    bindConnect();
  }
}

/** Swaps the banner's contents without touching any input. */
function updateErrorBanner(message?: string, hint?: string): void {
  const banner = document.getElementById('gate-error');
  if (!banner) return;
  if (!message) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML =
    `<div class="font-medium">${escapeHtml(message)}</div>` +
    (hint ? `<div class="mt-1" style="color:var(--muted)">${escapeHtml(hint)}</div>` : '');
}

/* ------------------------------------------------------------------------ */

function connectForm(errorMessage?: string, errorHint?: string): string {
  const saved = connection.getState().config;
  return `
<form id="connect-form" novalidate class="space-y-3.5">
  <div id="gate-error" class="rounded-xl p-3.5 text-[13px] leading-relaxed ${errorMessage ? '' : 'hidden'}"
       style="background:color-mix(in srgb, var(--accent) 14%, transparent); border:1px solid color-mix(in srgb, var(--accent) 35%, transparent)">
    ${errorMessage ? `<div class="font-medium">${escapeHtml(errorMessage)}</div>` : ''}
    ${errorHint ? `<div class="mt-1" style="color:var(--muted)">${escapeHtml(errorHint)}</div>` : ''}
  </div>

  <div>
    <label class="block text-[13px] font-medium mb-1.5" for="field-url">Supabase project URL</label>
    <input id="field-url" name="url" class="field" type="url" inputmode="url"
           autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
           placeholder="https://your-project.supabase.co"
           value="${escapeHtml(saved?.url ?? '')}">
    <p class="text-[12px] mt-1.5 hidden" data-error-for="url" style="color:var(--accent)"></p>
  </div>

  <div>
    <label class="block text-[13px] font-medium mb-1.5" for="field-key">Publishable key</label>
    <input id="field-key" name="publishableKey" class="field" type="password"
           autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
           placeholder="sb_publishable_… or eyJ…"
           value="${escapeHtml(saved?.publishableKey ?? '')}">
    <p class="text-[12px] mt-1.5" style="color:var(--subtle)">
      Settings → API Keys in your Supabase dashboard. Use the publishable
      (anon) key — never the secret or service-role key.
    </p>
    <p class="text-[12px] mt-1.5 hidden" data-error-for="publishableKey" style="color:var(--accent)"></p>
  </div>

  <div>
    <label class="block text-[13px] font-medium mb-1.5" for="field-bucket">Music bucket</label>
    <input id="field-bucket" name="bucket" class="field" type="text"
           autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
           placeholder="${DEFAULT_BUCKET}" value="${escapeHtml(saved?.bucket ?? DEFAULT_BUCKET)}">
    <p class="text-[12px] mt-1.5 hidden" data-error-for="bucket" style="color:var(--accent)"></p>
  </div>

  <label class="flex items-start gap-3 py-2 cursor-pointer">
    <input id="field-remember" type="checkbox" checked
           class="mt-0.5 w-5 h-5 rounded shrink-0 accent-[var(--accent)]">
    <span class="text-[13px] leading-relaxed">
      <span class="font-medium">Remember this connection</span>
      <span class="block mt-0.5" style="color:var(--muted)">
        Saves the project URL, publishable key and bucket name in this browser’s
        local storage so you go straight to your library next time. Your password
        is never stored; Supabase keeps its own refreshable session token.
        Avoid this on a shared device.
      </span>
    </span>
  </label>

  ${
    !storageAvailable()
      ? `<p class="text-[12px] rounded-lg p-2.5" style="background:var(--surface-2);color:var(--muted)">
           This browser is blocking local storage (Private Browsing?), so the
           connection cannot be remembered for next time.
         </p>`
      : ''
  }

  <div id="test-result" class="hidden text-[13px] rounded-xl p-3" style="background:var(--surface-2)"></div>

  <div class="flex gap-2.5 pt-1">
    <button type="button" id="btn-test" class="btn-ghost flex-1 py-3 text-[15px]">Test</button>
    <button type="submit" id="btn-connect" class="btn-accent flex-1 py-3 text-[15px]">Connect</button>
  </div>

  <p class="text-[12px] text-center leading-relaxed pt-1" style="color:var(--subtle)">
    Your credentials stay in this browser. They are never sent anywhere except
    directly to your own Supabase project.
  </p>
</form>`;
}

function readForm() {
  return {
    url: (document.getElementById('field-url') as HTMLInputElement)?.value ?? '',
    publishableKey: (document.getElementById('field-key') as HTMLInputElement)?.value ?? '',
    bucket: (document.getElementById('field-bucket') as HTMLInputElement)?.value ?? '',
  };
}

function showFieldErrors(errors: Record<string, string | undefined>): void {
  for (const field of ['url', 'publishableKey', 'bucket']) {
    const el = document.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
    const input = document.getElementById(
      `field-${field === 'publishableKey' ? 'key' : field}`,
    );
    const message = errors[field];
    if (el) {
      el.textContent = message ?? '';
      el.classList.toggle('hidden', !message);
    }
    input?.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
}

function bindConnect(): void {
  const form = $('connect-form') as HTMLFormElement | null;
  if (!form) return;

  $('btn-test')?.addEventListener('click', async () => {
    const button = $('btn-test') as HTMLButtonElement;
    const result = $('test-result')!;
    button.disabled = true;
    button.textContent = 'Testing…';
    result.classList.remove('hidden');
    result.innerHTML = 'Checking your project…';

    try {
      const test = await connection.test(readForm());
      const line = (ok: boolean, label: string) =>
        `<div class="flex items-center gap-2 py-0.5">
           <span style="color:${ok ? '#34d399' : 'var(--accent)'}">${ok ? icons.check(15) : icons.close(15)}</span>
           <span>${escapeHtml(label)}</span>
         </div>`;

      result.innerHTML =
        line(test.schemaReady, test.schemaReady ? 'Music tables found' : 'Music tables missing') +
        line(test.bucketReady, test.bucketReady ? 'Storage bucket found' : 'Storage bucket missing') +
        line(test.authenticated, test.authenticated ? 'Signed in' : 'Not signed in yet') +
        (test.trackCount !== null
          ? `<div class="mt-1.5 pt-1.5 border-t" style="border-color:var(--border);color:var(--muted)">
               ${test.trackCount} ${test.trackCount === 1 ? 'track' : 'tracks'} visible
             </div>`
          : '') +
        (test.error
          ? `<div class="mt-1.5 pt-1.5 border-t" style="border-color:var(--border);color:var(--muted)">
               ${escapeHtml(test.error.userMessage)}
               ${test.error.hint ? `<div class="mt-1">${escapeHtml(test.error.hint)}</div>` : ''}
             </div>`
          : '');
    } catch (error) {
      result.innerHTML = escapeHtml((error as Error).message);
    } finally {
      button.disabled = false;
      button.textContent = 'Test';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('btn-connect') as HTMLButtonElement;
    const remember = (document.getElementById('field-remember') as HTMLInputElement)?.checked ?? false;

    showFieldErrors({});
    button.disabled = true;
    button.textContent = 'Connecting…';

    try {
      const state = await connection.connect(readForm(), { remember });
      if (state.status === 'error' && state.error?.kind === 'invalid-config') {
        const { validateConfig } = await import('../connection/config');
        showFieldErrors(validateConfig(readForm()).errors);
      } else if (state.status === 'connected') {
        showToast('Connected');
        window.dispatchEvent(new CustomEvent('resonance:connected'));
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });
}

/* ------------------------------------------------------------------------ */

function signInForm(): string {
  const config = connection.getState().config;
  return `
<form id="signin-form" novalidate class="space-y-3.5">
  <div class="rounded-xl p-3.5 text-[13px] leading-relaxed" style="background:var(--surface-2)">
    Connected to <span class="font-medium">${escapeHtml(config?.url ?? '')}</span>.
    Your library is protected by Row Level Security, so sign in to load it.
  </div>

  <div>
    <label class="block text-[13px] font-medium mb-1.5" for="field-email">Email</label>
    <input id="field-email" class="field" type="email" inputmode="email"
           autocomplete="username" autocapitalize="none" autocorrect="off" placeholder="you@example.com">
  </div>

  <div>
    <label class="block text-[13px] font-medium mb-1.5" for="field-password">Password</label>
    <input id="field-password" class="field" type="password" autocomplete="current-password"
           placeholder="••••••••">
  </div>

  <p id="signin-error" class="text-[13px] hidden" style="color:var(--accent)"></p>

  <button type="submit" id="btn-signin" class="btn-accent w-full py-3 text-[15px]">Sign in</button>

  <div class="flex items-center justify-between pt-1">
    <button type="button" id="btn-change-project" class="text-[13px]" style="color:var(--muted)">
      Use a different project
    </button>
    <button type="button" id="btn-skip-auth" class="text-[13px]" style="color:var(--muted)">
      Continue without signing in
    </button>
  </div>

  <p class="text-[12px] leading-relaxed pt-1" style="color:var(--subtle)">
    Your password is sent only to your own Supabase project and is never stored
    in this browser. Supabase keeps a refreshable session token instead.
  </p>
</form>`;
}

function bindSignIn(): void {
  const form = $('signin-form') as HTMLFormElement | null;
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('btn-signin') as HTMLButtonElement;
    const errorEl = $('signin-error')!;
    const email = (document.getElementById('field-email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('field-password') as HTMLInputElement).value;

    errorEl.classList.add('hidden');
    button.disabled = true;
    button.textContent = 'Signing in…';

    try {
      await connection.signIn(email, password);
      showToast('Signed in');
      window.dispatchEvent(new CustomEvent('resonance:connected'));
    } catch (error) {
      errorEl.textContent = (error as { userMessage?: string }).userMessage ?? 'Could not sign in.';
      errorEl.classList.remove('hidden');
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  $('btn-change-project')?.addEventListener('click', () => {
    void connection.disconnect({ forget: true });
  });

  // Escape hatch for libraries whose RLS deliberately allows anonymous reads.
  $('btn-skip-auth')?.addEventListener('click', () => {
    connection.store.set({ status: 'connected' });
    window.dispatchEvent(new CustomEvent('resonance:connected'));
  });
}
