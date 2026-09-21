import { describe, it, expect, vi } from 'vitest';
import { createStore, select } from '@/lib/state/store';

describe('store', () => {
  it('exposes the current state', () => {
    expect(createStore({ count: 0 }).get()).toEqual({ count: 0 });
  });

  it('merges a partial update', () => {
    const store = createStore({ a: 1, b: 2 });
    store.set({ a: 5 });
    expect(store.get()).toEqual({ a: 5, b: 2 });
  });

  it('accepts a functional update', () => {
    const store = createStore({ count: 1 });
    store.set((s) => ({ count: s.count + 1 }));
    expect(store.get().count).toBe(2);
  });

  it('notifies subscribers with the new and previous state', () => {
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ count: 1 });
    expect(listener).toHaveBeenCalledWith({ count: 1 }, { count: 0 });
  });

  it('does NOT notify when nothing actually changed', () => {
    // This is what stops a 4Hz timeupdate from re-rendering the whole UI.
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ count: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires immediately when asked', () => {
    const listener = vi.fn();
    createStore({ count: 7 }).subscribe(listener, { immediate: true });
    expect(listener).toHaveBeenCalledWith({ count: 7 }, { count: 7 });
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener)();
    store.set({ count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps notifying other listeners when one throws', () => {
    const store = createStore({ count: 0 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    store.subscribe(() => { throw new Error('bad listener'); });
    store.subscribe(good);
    store.set({ count: 1 });
    expect(good).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('survives a listener unsubscribing during a notification', () => {
    const store = createStore({ count: 0 });
    const second = vi.fn();
    const off = store.subscribe(() => off());
    store.subscribe(second);
    expect(() => store.set({ count: 1 })).not.toThrow();
    expect(second).toHaveBeenCalled();
  });
});

describe('select', () => {
  it('fires only when the selected slice changes', () => {
    const store = createStore({ track: 'a', time: 0 });
    const listener = vi.fn();
    select(store, (s) => s.track, listener);

    store.set({ time: 10 });   // irrelevant to this selector
    expect(listener).not.toHaveBeenCalled();

    store.set({ track: 'b' });
    expect(listener).toHaveBeenCalledWith('b', 'a');
  });
});
