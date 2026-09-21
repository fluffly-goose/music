/** Canned Supabase data + a route handler, shared by the e2e scripts. */
import { deflateSync } from 'node:zlib';

export const PROJECT = 'https://demo.supabase.co';
export const ANON_KEY =
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') + '.' +
  Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url') + '.sig';

const OWNER = '11111111-1111-4111-8111-111111111111';

export const artists = [
  { id: 'ar1', owner_id: OWNER, name: 'Aurora Field', sort_name: null, bio: 'Ambient guitar and tape loops, recorded in a coastal cabin.', image_path: null, created_at: '2024-01-01' },
  { id: 'ar2', owner_id: OWNER, name: 'Low Harbour', sort_name: null, bio: null, image_path: null, created_at: '2024-01-02' },
  { id: 'ar3', owner_id: OWNER, name: 'Vesper Lane', sort_name: null, bio: null, image_path: null, created_at: '2024-01-03' },
];

export const albums = [
  { id: 'al1', owner_id: OWNER, artist_id: 'ar1', title: 'Slow Tide', sort_title: null, year: 2023, genre: 'Ambient', cover_path: `${OWNER}/albums/al1/cover.jpg`, created_at: '2024-03-01', artist: { id: 'ar1', name: 'Aurora Field' } },
  { id: 'al2', owner_id: OWNER, artist_id: 'ar2', title: 'Night Ferry', sort_title: null, year: 2022, genre: 'Electronic', cover_path: `${OWNER}/albums/al2/cover.jpg`, created_at: '2024-02-01', artist: { id: 'ar2', name: 'Low Harbour' } },
  { id: 'al3', owner_id: OWNER, artist_id: 'ar3', title: 'Paper Lanterns', sort_title: null, year: 2024, genre: 'Folk', cover_path: `${OWNER}/albums/al3/cover.jpg`, created_at: '2024-04-01', artist: { id: 'ar3', name: 'Vesper Lane' } },
  { id: 'al4', owner_id: OWNER, artist_id: 'ar1', title: 'Harbour Lights', sort_title: null, year: 2021, genre: 'Ambient', cover_path: null, created_at: '2024-01-15', artist: { id: 'ar1', name: 'Aurora Field' } },
];

const TITLES = {
  al1: ['Slow Tide', 'Driftwood', 'Salt Air', 'Low Sun', 'Undertow'],
  al2: ['Night Ferry', 'Harbour Lights', 'Deck Six', 'Morning Crossing'],
  al3: ['Paper Lanterns', 'Bicycle Bell', 'Long Way Home'],
  al4: ['First Light', 'Quay', 'Breakwater'],
};

export const tracks = [];
for (const album of albums) {
  TITLES[album.id].forEach((title, i) => {
    tracks.push({
      id: `${album.id}-t${i + 1}`, owner_id: OWNER, album_id: album.id, artist_id: album.artist_id,
      title, track_no: i + 1, disc_no: 1, duration_seconds: 150 + i * 23,
      audio_path: `${OWNER}/albums/${album.id}/0${i + 1}-${title.toLowerCase().replace(/ /g, '-')}.wav`,
      mime_type: 'audio/wav', file_size: 4000000, genre: album.genre, year: album.year,
      created_at: album.created_at,
      album: { id: album.id, title: album.title, cover_path: album.cover_path, year: album.year, artist: album.artist },
      artist: album.artist,
    });
  });
}

export const playlists = [
  { id: 'p1', owner_id: OWNER, name: 'Late Evening', description: 'Wind-down listening', cover_path: null, created_at: '2024-05-01', updated_at: '2024-05-02', playlist_tracks: [{ count: 4 }] },
  { id: 'p2', owner_id: OWNER, name: 'Focus', description: null, cover_path: null, created_at: '2024-05-03', updated_at: '2024-05-03', playlist_tracks: [{ count: 3 }] },
];

const playlistTracks = [
  { id: 'pt1', playlist_id: 'p1', track_id: 'al1-t1', position: 1, added_at: '2024-05-01', track: tracks[0] },
  { id: 'pt2', playlist_id: 'p1', track_id: 'al2-t2', position: 2, added_at: '2024-05-01', track: tracks[6] },
  { id: 'pt3', playlist_id: 'p1', track_id: 'al3-t1', position: 3, added_at: '2024-05-01', track: tracks[9] },
  { id: 'pt4', playlist_id: 'p1', track_id: 'al1-t4', position: 4, added_at: '2024-05-01', track: tracks[3] },
];

/* -- a real, decodable WAV so <audio> genuinely plays ---------------------- */
export function makeWav(seconds = 240, freq = 220) {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / 400) * Math.min(1, (samples - i) / 400);
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000 * env), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A small JPEG-ish PNG cover, coloured per album. */
export function makeCover(hue) {
  const size = 200;
  const rgba = Buffer.alloc(size * size * 4);
  const hsl = (h, s, l) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const t = (x + y) / (size * 2);
    const [r, g, b] = hsl((hue + t * 40) % 360, 0.5, 0.25 + t * 0.3);
    const i = (y * size + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let b = 0; b < 8; b++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const SESSION = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: OWNER, aud: 'authenticated', role: 'authenticated', email: 'me@example.com',
    app_metadata: {}, user_metadata: {}, created_at: '2024-01-01T00:00:00Z',
  },
};

/** Installs the Supabase mock onto a Playwright page. */
export async function installMock(page, options = {}) {
  await page.route('**/demo.supabase.co/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body, headers = {}) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        headers: {
          'access-control-allow-origin': '*',
          // Real Supabase sets this; without it the browser hides content-range
          // from JS and every .count comes back null.
          'access-control-expose-headers': 'content-range, content-length',
          ...headers,
        },
        body: JSON.stringify(body) });

    // --- auth -------------------------------------------------------------
    if (path.startsWith('/auth/v1/token')) return json(SESSION);
    if (path.startsWith('/auth/v1/user')) return json(SESSION.user);

    // --- storage ----------------------------------------------------------
    if (path.startsWith('/storage/v1/object/list/')) return json([{ name: 'albums' }]);
    if (path.startsWith('/storage/v1/object/sign/')) {
      const body = route.request().postDataJSON?.() ?? {};
      if (Array.isArray(body.paths)) {
        return json(body.paths.map((p) => ({ path: p, signedURL: `/mock-asset?p=${encodeURIComponent(p)}`, error: null })));
      }
      const key = decodeURIComponent(path.replace(/^\/storage\/v1\/object\/sign\/[^/]+\//, ''));
      return json({ signedURL: `/mock-asset?p=${encodeURIComponent(key)}` });
    }

    // --- rest -------------------------------------------------------------
    if (!path.startsWith('/rest/v1/')) return json({});
    const table = path.replace('/rest/v1/', '');
    const prefer = route.request().headers()['prefer'] ?? '';
    const wantsCount = prefer.includes('count=');
    const isHead = route.request().method() === 'HEAD';

    const countHeaders = (n) => ({ 'content-range': `0-${Math.max(n - 1, 0)}/${n}` });

    let rows = [];
    if (table === 'tracks') {
      rows = tracks;
      const albumEq = url.searchParams.get('album_id');
      const artistEq = url.searchParams.get('artist_id');
      const idEq = url.searchParams.get('id');
      const ilike = url.searchParams.get('title');
      if (albumEq) rows = rows.filter((t) => t.album_id === albumEq.replace('eq.', ''));
      if (artistEq) rows = rows.filter((t) => t.artist_id === artistEq.replace('eq.', ''));
      if (idEq) rows = rows.filter((t) => t.id === idEq.replace('eq.', ''));
      if (ilike?.startsWith('ilike.')) {
        const term = ilike.slice(6).replace(/%/g, '').toLowerCase();
        rows = rows.filter((t) => t.title.toLowerCase().includes(term));
      }
    } else if (table === 'albums') {
      rows = albums;
      const idEq = url.searchParams.get('id');
      const artistEq = url.searchParams.get('artist_id');
      const ilike = url.searchParams.get('title');
      if (idEq) rows = rows.filter((a) => a.id === idEq.replace('eq.', ''));
      if (artistEq) rows = rows.filter((a) => a.artist_id === artistEq.replace('eq.', ''));
      if (ilike?.startsWith('ilike.')) {
        const term = ilike.slice(6).replace(/%/g, '').toLowerCase();
        rows = rows.filter((a) => a.title.toLowerCase().includes(term));
      }
    } else if (table === 'artists') {
      rows = artists;
      const idEq = url.searchParams.get('id');
      const ilike = url.searchParams.get('name');
      if (idEq) rows = rows.filter((a) => a.id === idEq.replace('eq.', ''));
      if (ilike?.startsWith('ilike.')) {
        const term = ilike.slice(6).replace(/%/g, '').toLowerCase();
        rows = rows.filter((a) => a.name.toLowerCase().includes(term));
      }
    } else if (table === 'playlists') {
      rows = playlists;
      const idEq = url.searchParams.get('id');
      if (idEq) rows = rows.filter((p) => p.id === idEq.replace('eq.', ''));
    } else if (table === 'playlist_tracks') {
      rows = playlistTracks;
      const pid = url.searchParams.get('playlist_id');
      if (pid) rows = rows.filter((r) => r.playlist_id === pid.replace('eq.', ''));
    } else if (table === 'play_history') {
      if (route.request().method() === 'POST') return json([], {});
      rows = options.emptyHistory ? [] : [
        { track_id: 'al2-t1', played_at: '2024-06-01', track: tracks[5] },
        { track_id: 'al1-t3', played_at: '2024-05-31', track: tracks[2] },
        { track_id: 'al3-t2', played_at: '2024-05-30', track: tracks[10] },
      ];
    } else if (table === 'user_preferences') {
      rows = [];
    }

    if (options.emptyLibrary) rows = [];

    // Honour the single-object Accept header PostgREST uses for .single().
    const accept = route.request().headers()['accept'] ?? '';
    if (accept.includes('vnd.pgrst.object')) {
      return json(rows[0] ?? null, wantsCount ? countHeaders(rows.length) : {});
    }
    if (isHead) {
      return route.fulfill({ status: 200, headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'content-range, content-length',
        ...countHeaders(rows.length) }, body: '' });
    }
    return json(rows, wantsCount ? countHeaders(rows.length) : {});
  });

  // Signed URLs resolve to these.
  await page.route('**/mock-asset*', async (route) => {
    const p = new URL(route.request().url()).searchParams.get('p') ?? '';
    if (p.endsWith('.jpg') || p.endsWith('.png')) {
      const hue = (p.charCodeAt(p.length - 10) * 37) % 360;
      return route.fulfill({ status: 200, contentType: 'image/png', body: makeCover(hue) });
    }
    return route.fulfill({
      status: 200, contentType: 'audio/wav',
      headers: { 'accept-ranges': 'bytes' },
      // Long enough that no track ends mid-test unless a test wants it to.
      body: makeWav(options.shortAudio ? 3 : 240, 200 + (p.length % 6) * 40),
    });
  });
}

/** Seeds a remembered connection + session so the app boots straight in. */
export async function seedConnection(page) {
  await page.addInitScript(
    ([project, key, session]) => {
      localStorage.setItem('resonance:connection', JSON.stringify({
        version: 1, savedAt: new Date().toISOString(),
        url: project, publishableKey: key, bucket: 'music',
      }));
      localStorage.setItem('resonance:auth', JSON.stringify(session));
    },
    [PROJECT, ANON_KEY, SESSION],
  );
}
