/**
 * A ~40-line observable store.
 *
 * The brief asked for state management "suitable for Astro" without dragging in
 * a framework. Playback state has exactly one writer (the player service) and
 * many readers (mini player, now playing, track rows), so a subscribe/notify
 * store is genuinely all that is needed here.
 */

export type Listener<T> = (state: T, previous: T) => void;
export type Unsubscribe = () => void;

export interface Store<T> {
  get(): T;
  set(updater: Partial<T> | ((current: T) => Partial<T>)): void;
  subscribe(listener: Listener<T>, options?: { immediate?: boolean }): Unsubscribe;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();

  return {
    get: () => state,

    set(updater) {
      const patch = typeof updater === 'function' ? updater(state) : updater;
      if (!patch) return;

      // Skip the notify entirely when nothing actually changed. Without this,
      // things like timeupdate (4x/second) would re-render the whole UI.
      let changed = false;
      for (const key of Object.keys(patch) as (keyof T)[]) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;

      const previous = state;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) {
        try {
          listener(state, previous);
        } catch (error) {
          console.error('[store] listener threw', error);
        }
      }
    },

    subscribe(listener, options = {}) {
      listeners.add(listener);
      if (options.immediate) {
        try {
          listener(state, state);
        } catch (error) {
          console.error('[store] listener threw', error);
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Subscribe but only fire when one derived slice changes. */
export function select<T extends object, S>(
  store: Store<T>,
  selector: (state: T) => S,
  listener: (value: S, previous: S) => void,
  options: { immediate?: boolean } = {},
): Unsubscribe {
  let current = selector(store.get());
  if (options.immediate) listener(current, current);
  return store.subscribe((state) => {
    const next = selector(state);
    if (!Object.is(next, current)) {
      const previous = current;
      current = next;
      listener(next, previous);
    }
  });
}
