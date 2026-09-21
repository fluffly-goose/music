/**
 * A modal form sheet.
 *
 * One presentation for every "edit this" flow in the app: a scrim, a panel
 * that rises from the bottom, a grab handle you can actually drag, and a
 * grouped form. Screens describe the fields they want and get back the
 * values; nothing here knows about albums or tracks.
 */

import { escapeHtml } from '../utils/format';
import { icons } from './icons';
import { showToast } from './render';
import { AppError } from '../utils/errors';

export interface EditField {
  name: string;
  label: string;
  value: string | number | null | undefined;
  type?: 'text' | 'number' | 'textarea';
  placeholder?: string;
  /** Rendered under the group, for things a label cannot carry. */
  hint?: string;
  required?: boolean;
  maxLength?: number;
  inputMode?: 'text' | 'numeric';
}

export interface EditSheetOptions {
  title: string;
  fields: EditField[];
  submitLabel?: string;
  /** Rendered above the form: artwork, a warning, anything contextual. */
  header?: string;
  /** Wired up after the sheet is in the DOM, e.g. for an artwork picker. */
  onMount?: (panel: HTMLElement) => void;
  /**
   * Saves. Throwing shows the message inline and keeps the sheet open, so a
   * failed save never loses what the user typed.
   */
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  /** Optional destructive action, shown apart from the form. */
  danger?: {
    label: string;
    /** Shown in a confirm() before anything happens. */
    confirm: string;
    onSelect: () => Promise<void> | void;
  };
}

let activeCleanup: (() => void) | null = null;

function fieldMarkup(field: EditField): string {
  const id = `edit-${field.name}`;
  const value = field.value ?? '';
  const common =
    `id="${id}" name="${escapeHtml(field.name)}" class="form-input" ` +
    `placeholder="${escapeHtml(field.placeholder ?? '')}" ` +
    (field.maxLength ? `maxlength="${field.maxLength}" ` : '') +
    (field.inputMode ? `inputmode="${field.inputMode}" ` : '') +
    'autocapitalize="sentences" autocorrect="off" spellcheck="false"';

  const control =
    field.type === 'textarea'
      ? `<textarea ${common} rows="3">${escapeHtml(value)}</textarea>`
      : `<input ${common} type="${field.type === 'number' ? 'text' : 'text'}" value="${escapeHtml(value)}">`;

  return `
<div class="form-row">
  <label class="form-label" for="${id}">${escapeHtml(field.label)}</label>
  ${control}
</div>`;
}

/** Opens the sheet. Resolves once it has closed. */
export function openEditSheet(options: EditSheetOptions): Promise<void> {
  activeCleanup?.();

  return new Promise<void>((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', options.title);

    const groups = options.fields.map(fieldMarkup).join('');
    const hints = options.fields
      .filter((f) => f.hint)
      .map((f) => `<p class="form-hint">${escapeHtml(f.hint!)}</p>`)
      .join('');

    root.innerHTML = `
<div class="modal-scrim" data-close></div>
<div class="modal-panel">
  <div class="modal-grip" aria-hidden="true"></div>
  <div class="modal-header">
    <button type="button" class="tap -ml-2 text-[15px]" data-close style="color:var(--muted)">Cancel</button>
    <span class="modal-title">${escapeHtml(options.title)}</span>
    <button type="submit" form="edit-form" class="tap -mr-2 text-[15px] font-semibold"
            data-save style="color:var(--accent)">${escapeHtml(options.submitLabel ?? 'Save')}</button>
  </div>
  <div class="modal-body">
    ${options.header ?? ''}
    <form id="edit-form" novalidate>
      <div class="form-group">${groups}</div>
      ${hints}
      <p class="form-error hidden" data-form-error></p>
      ${
        options.danger
          ? `<div class="mt-5"><button type="button" class="btn-danger" data-danger>
               ${escapeHtml(options.danger.label)}
             </button></div>`
          : ''
      }
    </form>
  </div>
</div>`;

    document.body.appendChild(root);
    const panel = root.querySelector<HTMLElement>('.modal-panel')!;
    const form = root.querySelector<HTMLFormElement>('#edit-form')!;
    const errorEl = root.querySelector<HTMLElement>('[data-form-error]')!;
    const saveButton = root.querySelector<HTMLButtonElement>('[data-save]')!;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Next frame, so the opening transition actually runs.
    requestAnimationFrame(() => root.classList.add('is-open'));

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      activeCleanup = null;
      root.classList.remove('is-open');
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      setTimeout(() => {
        root.remove();
        resolve();
      }, 340);
    };
    activeCleanup = close;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);

    for (const el of root.querySelectorAll('[data-close]')) {
      el.addEventListener('click', close);
    }

    // Drag the panel down to dismiss. Following the finger matters more than
    // the threshold: it is what makes the sheet feel physical.
    let startY = 0;
    let dragging = false;
    panel.addEventListener('touchstart', (e) => {
      const body = root.querySelector<HTMLElement>('.modal-body');
      // Only start a drag from the top of a scrolled-to-top body, or the grip.
      if (body && body.scrollTop > 0) return;
      startY = e.touches[0]?.clientY ?? 0;
      dragging = true;
      panel.style.transition = 'none';
    }, { passive: true });

    panel.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const delta = (e.touches[0]?.clientY ?? 0) - startY;
      if (delta > 0) panel.style.transform = `translateY(${delta}px)`;
    }, { passive: true });

    panel.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = '';
      const delta = (e.changedTouches[0]?.clientY ?? 0) - startY;
      panel.style.transform = '';
      if (delta > 110) close();
    }, { passive: true });

    root.querySelector('[data-danger]')?.addEventListener('click', async () => {
      const danger = options.danger!;
      if (!window.confirm(danger.confirm)) return;
      try {
        await danger.onSelect();
        close();
      } catch (error) {
        showToast(
          error instanceof AppError ? error.userMessage : 'That did not work.',
          'error',
        );
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.add('hidden');

      const values: Record<string, string> = {};
      for (const field of options.fields) {
        const input = form.elements.namedItem(field.name) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        values[field.name] = (input?.value ?? '').trim();
      }

      const missing = options.fields.find((f) => f.required && !values[f.name]);
      if (missing) {
        errorEl.textContent = `${missing.label} cannot be empty.`;
        errorEl.classList.remove('hidden');
        return;
      }

      const original = saveButton.innerHTML;
      saveButton.disabled = true;
      saveButton.innerHTML = '<span class="spinner"></span>';

      try {
        await options.onSubmit(values);
        close();
      } catch (error) {
        // Keep the sheet open: a failed save must not discard the edit.
        errorEl.textContent =
          error instanceof AppError ? error.userMessage : 'Could not save those changes.';
        errorEl.classList.remove('hidden');
        saveButton.disabled = false;
        saveButton.innerHTML = original;
      }
    });

    options.onMount?.(panel);
    // Focus the first field, but not on touch devices where it would throw up
    // the keyboard and cover the sheet before it has finished opening.
    if (!window.matchMedia('(hover: none)').matches) {
      setTimeout(() => form.querySelector<HTMLInputElement>('.form-input')?.focus(), 360);
    }
  });
}

/** Artwork block for the top of an edit sheet, with a "Change" affordance. */
export function artworkHeader(options: {
  src: string;
  round?: boolean;
  label?: string;
}): string {
  return `
<div class="flex justify-center pb-4">
  <button type="button" class="art-edit w-32 h-32 ${options.round ? 'rounded-full' : 'rounded-xl'}"
          data-art-picker aria-label="${escapeHtml(options.label ?? 'Change artwork')}">
    <img src="${escapeHtml(options.src)}" alt="" class="w-full h-full object-cover">
    <span class="art-edit-badge">${icons.plus(12)} Change</span>
  </button>
  <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" data-art-input>
</div>`;
}
