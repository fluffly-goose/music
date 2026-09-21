/**
 * Signed URL cache.
 *
 * A private bucket means every byte of audio and artwork is reached through a
 * time-limited signed URL. Minting one costs a round trip, so we cache them and
 * treat them as expired slightly early - a URL that dies mid-request produces a
 * much worse experience than one refreshed a minute too soon.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError, toAppError } from '../utils/errors';

/** How long Supabase is asked to sign for. */
export const DEFAULT_TTL_SECONDS = 3600;
/**
 * Treat a URL as stale once 80% of its life is gone. For a 1h URL that is a
 * 12-minute safety margin, comfortably longer than any single track.
 */
const REFRESH_RATIO = 0.8;

interface CacheEntry {
  url: string;
  /** Epoch ms at which we stop handing this out. */
  staleAt: number;
  /** Epoch ms of true expiry, for diagnostics. */
  expiresAt: number;
}

export interface SignedUrlCacheOptions {
  ttlSeconds?: number;
  /** Injectable for tests. */
  now?: () => number;
  maxEntries?: number;
}

export class SignedUrlCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<string>>();
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: SignedUrlCacheOptions = {}) {
    this.ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = options.maxEntries ?? 300;
  }

  private key(bucket: string, path: string): string {
    return `${bucket}::${path}`;
  }

  /** A cached, still-fresh URL, or null. */
  peek(bucket: string, path: string): string | null {
    const entry = this.entries.get(this.key(bucket, path));
    if (!entry) return null;
    if (this.now() >= entry.staleAt) return null;
    return entry.url;
  }

  /**
   * Returns a usable URL, minting one if needed.
   * `force` skips the cache - used after a 403, when the URL we handed out
   * turned out to be dead despite our bookkeeping.
   */
  async get(
    client: SupabaseClient,
    bucket: string,
    path: string,
    options: { force?: boolean } = {},
  ): Promise<string> {
    const key = this.key(bucket, path);

    if (!options.force) {
      const cached = this.peek(bucket, path);
      if (cached) return cached;
      // Coalesce: a screen showing 30 tiles of one album must not fire 30
      // identical sign requests.
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }

    const request = this.sign(client, bucket, path)
      .then((url) => {
        const issuedAt = this.now();
        this.entries.set(key, {
          url,
          staleAt: issuedAt + this.ttl * 1000 * REFRESH_RATIO,
          expiresAt: issuedAt + this.ttl * 1000,
        });
        this.evictIfNeeded();
        return url;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, request);
    return request;
  }

  private async sign(client: SupabaseClient, bucket: string, path: string): Promise<string> {
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, this.ttl);
    if (error || !data?.signedUrl) {
      const mapped = toAppError(error ?? new Error('No signed URL returned'), `Signing ${path}`);
      if (mapped.kind === 'unknown') {
        throw new AppError('signed-url', `Could not get a playable link for ${path}.`, {
          hint: 'Check that the file exists in the bucket and that the storage policies allow reading it.',
          cause: error,
        });
      }
      throw mapped;
    }
    return data.signedUrl;
  }

  /** Signs many paths at once, skipping ones already cached. */
  async getMany(
    client: SupabaseClient,
    bucket: string,
    paths: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(paths.filter(Boolean))];
    const out = new Map<string, string>();
    const missing: string[] = [];

    for (const path of unique) {
      const cached = this.peek(bucket, path);
      if (cached) out.set(path, cached);
      else missing.push(path);
    }
    if (missing.length === 0) return out;

    const { data, error } = await client.storage.from(bucket).createSignedUrls(missing, this.ttl);
    if (error) throw toAppError(error, 'Signing artwork');

    const issuedAt = this.now();
    for (const row of data ?? []) {
      if (!row.signedUrl || !row.path) continue;
      this.entries.set(this.key(bucket, row.path), {
        url: row.signedUrl,
        staleAt: issuedAt + this.ttl * 1000 * REFRESH_RATIO,
        expiresAt: issuedAt + this.ttl * 1000,
      });
      out.set(row.path, row.signedUrl);
    }
    this.evictIfNeeded();
    return out;
  }

  invalidate(bucket: string, path: string): void {
    this.entries.delete(this.key(bucket, path));
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drops expired entries first, then oldest, keeping memory bounded. */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

export const signedUrls = new SignedUrlCache();
