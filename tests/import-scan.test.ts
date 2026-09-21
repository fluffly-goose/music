import { describe, it, expect } from 'vitest';
import { scanFiles } from '@/lib/library/import';

/**
 * Builds a genuinely parseable MP3: ID3v2.3 tags + MPEG-1 Layer III frames.
 *
 * Written with Uint8Array rather than Node's Buffer so this file stays
 * browser-typed; the tsconfig covering src/ deliberately does not pull in
 * Node globals, which would let them leak into client code.
 */
function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeMp3(tags: {
  title?: string; artist?: string; album?: string;
  track?: number; year?: number; genre?: string; seconds?: number;
}): ArrayBuffer {
  const frame = (id: string, text: string): Uint8Array => {
    const body = concat([new Uint8Array([0x00]), latin1(text), new Uint8Array([0x00])]);
    const header = new Uint8Array(10);
    header.set(latin1(id), 0);
    new DataView(header.buffer).setUint32(4, body.length);
    return concat([header, body]);
  };
  const syncsafe = (n: number) =>
    new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

  const frames: Uint8Array[] = [];
  if (tags.title) frames.push(frame('TIT2', tags.title));
  if (tags.artist) frames.push(frame('TPE1', tags.artist));
  if (tags.album) frames.push(frame('TALB', tags.album));
  if (tags.track) frames.push(frame('TRCK', String(tags.track)));
  if (tags.year) frames.push(frame('TYER', String(tags.year)));
  if (tags.genre) frames.push(frame('TCON', tags.genre));

  const body = concat(frames);
  const tag = concat([latin1('ID3'), new Uint8Array([0x03, 0x00, 0x00]), syncsafe(body.length), body]);

  const FRAME_BYTES = 417; // 128 kbps, 44.1 kHz
  const count = Math.round(((tags.seconds ?? 4) * 44100) / 1152);
  const audio = new Uint8Array(FRAME_BYTES * count);
  for (let i = 0; i < count; i++) {
    const o = i * FRAME_BYTES;
    audio[o] = 0xff; audio[o + 1] = 0xfb; audio[o + 2] = 0x90; audio[o + 3] = 0x00;
  }

  const bytes = concat([tag, audio]);
  // Return a plain ArrayBuffer: a Uint8Array view is no longer assignable to
  // BlobPart under TypeScript's narrowed ArrayBufferLike typing.
  return bytes.buffer.slice(0) as ArrayBuffer;
}

const mp3File = (name: string, tags: Parameters<typeof makeMp3>[0] = {}) =>
  new File([makeMp3(tags)], name, { type: 'audio/mpeg' });

describe('scanning files', () => {
  it('reads title, artist, album, track number, year and genre from tags', async () => {
    const file = mp3File('whatever.mp3', {
      title: 'Salt Air', artist: 'Aurora Field', album: 'Slow Tide',
      track: 3, year: 2023, genre: 'Ambient',
    });

    const result = await scanFiles([file]);
    expect(result.rejected).toHaveLength(0);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      title: 'Salt Air',
      artistName: 'Aurora Field',
      albumTitle: 'Slow Tide',
      trackNo: 3,
      year: 2023,
      genre: 'Ambient',
      mimeType: 'audio/mpeg',
      extension: '.mp3',
    });
  });

  it('measures duration so the library shows real track lengths', async () => {
    const result = await scanFiles([mp3File('a.mp3', { title: 'X', seconds: 6 })]);
    expect(result.tracks[0]!.durationSeconds).toBeGreaterThan(5);
    expect(result.tracks[0]!.durationSeconds).toBeLessThan(7);
  });

  it('falls back to the filename when a file carries no tags', async () => {
    const result = await scanFiles([mp3File('03 - Driftwood.mp3')]);
    expect(result.tracks[0]!.title).toBe('Driftwood');
    expect(result.tracks[0]!.artistName).toBe('Unknown Artist');
    expect(result.tracks[0]!.albumTitle).toBe('Unknown Album');
  });

  it('strips a leading index from the filename fallback', async () => {
    for (const [name, expected] of [
      ['01 Slow Tide.mp3', 'Slow Tide'],
      ['02_Driftwood.mp3', 'Driftwood'],
      ['3. Salt Air.mp3', 'Salt Air'],
      ['03 - Undertow.mp3', 'Undertow'],
      ['4) Low Sun.mp3', 'Low Sun'],
    ] as const) {
      const result = await scanFiles([mp3File(name)]);
      expect(result.tracks[0]!.title).toBe(expected);
    }
  });

  it('does not mangle titles that genuinely start with a number', async () => {
    for (const name of ['99 Luftballons.mp3', '7 Nation Army.mp3', '1979.mp3']) {
      const result = await scanFiles([mp3File(name)]);
      expect(result.tracks[0]!.title).toBe(name.replace('.mp3', ''));
    }
  });

  it('warns about formats Safari cannot play, without rejecting them', async () => {
    const flac = new File([makeMp3({ title: 'X' })], 'track.flac', { type: 'audio/flac' });
    const result = await scanFiles([flac]);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]!.warning).toMatch(/Safari cannot play/i);
  });

  it('rejects non-audio files with a reason', async () => {
    const result = await scanFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    expect(result.tracks).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({ name: 'notes.txt' });
    expect(result.rejected[0]!.reason).toMatch(/not an audio file/i);
  });

  it('rejects empty files', async () => {
    const result = await scanFiles([new File([], 'empty.mp3', { type: 'audio/mpeg' })]);
    expect(result.rejected[0]!.reason).toMatch(/empty/i);
  });

  it('rejects files larger than the bucket limit before uploading them', async () => {
    const huge = new File([new Uint8Array(8)], 'huge.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(huge, 'size', { value: 500 * 1024 * 1024 });
    const result = await scanFiles([huge]);
    expect(result.tracks).toHaveLength(0);
    expect(result.rejected[0]!.reason).toMatch(/MB limit/i);
  });

  it('keeps the good files when some are unusable', async () => {
    const result = await scanFiles([
      mp3File('good.mp3', { title: 'Good' }),
      new File(['x'], 'bad.txt', { type: 'text/plain' }),
    ]);
    expect(result.tracks).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it('reports scan progress', async () => {
    const seen: number[] = [];
    await scanFiles(
      [mp3File('a.mp3', { title: 'A' }), mp3File('b.mp3', { title: 'B' })],
      (done, total) => { seen.push(done); expect(total).toBe(2); },
    );
    expect(seen.at(-1)).toBe(2);
  });

  it('gives every scanned track a distinct key', async () => {
    const result = await scanFiles([
      mp3File('a.mp3', { title: 'A' }),
      mp3File('b.mp3', { title: 'B' }),
    ]);
    const keys = result.tracks.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('handles an empty selection', async () => {
    expect(await scanFiles([])).toEqual({ tracks: [], rejected: [] });
  });
});
