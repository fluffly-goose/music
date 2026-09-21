import { describe, it, expect } from 'vitest';
import { SignedUrlCache } from '@/lib/player/urls';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Minimal stand-in for the Storage half of a Supabase client. */
function mockClient(options: { fail?: boolean; error?: unknown } = {}) {
  const calls = { createSignedUrl: 0, createSignedUrls: 0 };
  let counter = 0;

  const client = {
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => {
          calls.createSignedUrl++;
          if (options.fail) return { data: null, error: options.error ?? { message: 'Object not found', status: 404 } };
          return { data: { signedUrl: `https://cdn.test/${path}?token=${++counter}` }, error: null };
        },
        createSignedUrls: async (paths: string[]) => {
          calls.createSignedUrls++;
          if (options.fail) return { data: null, error: options.error ?? { message: 'Object not found' } };
          return {
            data: paths.map((p) => ({ path: p, signedUrl: `https://cdn.test/${p}?token=${++counter}`, error: null })),
            error: null,
          };
        },
      }),
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

describe('signed url cache', () => {
  it('signs a path and returns the url', async () => {
    const { client, calls } = mockClient();
    const cache = new SignedUrlCache();
    const url = await cache.get(client, 'music', 'a/track.mp3');
    expect(url).toContain('a/track.mp3');
    expect(calls.createSignedUrl).toBe(1);
  });

  it('serves a second request from cache without another round trip', async () => {
    const { client, calls } = mockClient();
    const cache = new SignedUrlCache();
    const first = await cache.get(client, 'music', 'a/track.mp3');
    const second = await cache.get(client, 'music', 'a/track.mp3');
    expect(second).toBe(first);
    expect(calls.createSignedUrl).toBe(1);
  });

  it('coalesces concurrent requests for the same path into one call', async () => {
    const { client, calls } = mockClient();
    const cache = new SignedUrlCache();
    const [a, b, c] = await Promise.all([
      cache.get(client, 'music', 'x.mp3'),
      cache.get(client, 'music', 'x.mp3'),
      cache.get(client, 'music', 'x.mp3'),
    ]);
    expect(calls.createSignedUrl).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('keys separately per bucket', async () => {
    const { client } = mockClient();
    const cache = new SignedUrlCache();
    const a = await cache.get(client, 'music', 'same.mp3');
    const b = await cache.get(client, 'other', 'same.mp3');
    expect(a).not.toBe(b);
  });

  it('re-signs once the url passes its refresh threshold', async () => {
    let now = 1_000_000;
    const { client, calls } = mockClient();
    // 100s TTL -> considered stale at 80s.
    const cache = new SignedUrlCache({ ttlSeconds: 100, now: () => now });

    const first = await cache.get(client, 'music', 'track.mp3');
    now += 79_000;
    expect(await cache.get(client, 'music', 'track.mp3')).toBe(first);
    expect(calls.createSignedUrl).toBe(1);

    now += 2_000; // now 81s in: past the 80% mark
    const refreshed = await cache.get(client, 'music', 'track.mp3');
    expect(refreshed).not.toBe(first);
    expect(calls.createSignedUrl).toBe(2);
  });

  it('refreshes early enough that a url never expires mid-track', async () => {
    let now = 0;
    const cache = new SignedUrlCache({ ttlSeconds: 3600, now: () => now });
    const { client } = mockClient();
    await cache.get(client, 'music', 't.mp3');
    // 12 minutes of headroom is longer than essentially any single song.
    now += 2_880_000; // 48 min - the refresh point
    expect(cache.peek('music', 't.mp3')).toBeNull();
  });

  it('force bypasses a still-fresh cache entry', async () => {
    const { client, calls } = mockClient();
    const cache = new SignedUrlCache();
    const first = await cache.get(client, 'music', 'track.mp3');
    const forced = await cache.get(client, 'music', 'track.mp3', { force: true });
    expect(forced).not.toBe(first);
    expect(calls.createSignedUrl).toBe(2);
  });

  it('invalidate drops an entry so the next read re-signs', async () => {
    const { client, calls } = mockClient();
    const cache = new SignedUrlCache();
    await cache.get(client, 'music', 'track.mp3');
    cache.invalidate('music', 'track.mp3');
    expect(cache.peek('music', 'track.mp3')).toBeNull();
    await cache.get(client, 'music', 'track.mp3');
    expect(calls.createSignedUrl).toBe(2);
  });

  it('maps a missing object to a helpful AppError', async () => {
    const { client } = mockClient({ fail: true });
    const cache = new SignedUrlCache();
    await expect(cache.get(client, 'music', 'gone.mp3')).rejects.toMatchObject({
      kind: 'missing-file',
    });
  });

  it('does not cache a failed signing attempt', async () => {
    const { client } = mockClient({ fail: true });
    const cache = new SignedUrlCache();
    await expect(cache.get(client, 'music', 'gone.mp3')).rejects.toThrow();
    expect(cache.peek('music', 'gone.mp3')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('batch-signs only the paths it does not already hold', async () => {
    const { client, calls } = mockClient();
    const cache = new SignedUrlCache();
    await cache.get(client, 'music', 'a.jpg');
    const urls = await cache.getMany(client, 'music', ['a.jpg', 'b.jpg', 'c.jpg']);
    expect(urls.size).toBe(3);
    expect(calls.createSignedUrls).toBe(1);
  });

  it('de-duplicates paths within one batch', async () => {
    const { client } = mockClient();
    const cache = new SignedUrlCache();
    const urls = await cache.getMany(client, 'music', ['a.jpg', 'a.jpg', 'b.jpg']);
    expect(urls.size).toBe(2);
  });

  it('evicts old entries to stay within its memory bound', async () => {
    const { client } = mockClient();
    const cache = new SignedUrlCache({ maxEntries: 5 });
    for (let i = 0; i < 20; i++) await cache.get(client, 'music', `t${i}.mp3`);
    expect(cache.size).toBeLessThanOrEqual(5);
  });

  it('clear empties everything', async () => {
    const { client } = mockClient();
    const cache = new SignedUrlCache();
    await cache.get(client, 'music', 'a.mp3');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
