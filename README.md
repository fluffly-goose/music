# Resonance

A personal, iPhone-first music streaming web app. It connects to **your own**
Supabase project, reads your library from Postgres, and streams the audio from
your own private Storage bucket.

No subscription, no third-party service, and no need to keep your whole library
on your phone. The site is fully static, so the same deployment works for anyone
who points it at their own Supabase project.

```
┌────────────┐   project URL + publishable key   ┌──────────────────┐
│  Browser   │ ────────────────────────────────► │  YOUR Supabase   │
│ (this app) │ ◄──── signed URLs, metadata ───── │  Postgres + S3   │
└────────────┘                                   └──────────────────┘
```

---

## Contents

- [Quick start](#quick-start)
- [Supabase setup](#supabase-setup)
- [Getting music in](#getting-music-in)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Deployment](#deployment)
- [Letting other people use it](#letting-other-people-use-it)
- [Commands](#commands)
- [Known limitations](#known-limitations)
- [Testing](#testing)

---

## Quick start

**Requires Node 22.12 or newer** (Astro 7's minimum). Check with `node -v`.

```bash
npm install
npm run dev          # http://localhost:4321
```

On first load you'll get an onboarding screen. Enter your Supabase project URL,
your **publishable (anon) key**, and your bucket name. Press **Test** to check
the project before committing, then **Connect**.

If you haven't set up Supabase yet, do that first — see below.

---

## Supabase setup

You need a Supabase project (the free tier is fine). Everything below is a
one-time setup.

### 1. Run the migrations

Open your project's **SQL Editor** and run these three files in order:

| File | What it does |
|---|---|
| `supabase/migrations/0001_schema.sql` | Tables, indexes, triggers |
| `supabase/migrations/0002_rls.sql` | Row Level Security policies |
| `supabase/migrations/0003_storage.sql` | Creates the private `music` bucket and its policies |

### 2. Create your user

**Authentication → Users → Add user.** Use email + password and tick
"Auto Confirm User". Copy the user's UUID — the importer needs it.

Every row in the database carries an `owner_id`, and every RLS policy checks
`owner_id = auth.uid()`. That one column is what keeps separate libraries
separate, and it's why the app asks you to sign in.

### 3. Get your keys

**Settings → API Keys.** You want the **publishable** key (`sb_publishable_…`)
or the legacy **anon** key (`eyJ…`).

> Never use the `service_role` or `sb_secret_` key in the browser. It bypasses
> RLS entirely. The app actively refuses to accept one and tells you why.

### Storage layout

The bucket is private. The first path segment is the owner's user id, which is
exactly what the Storage policy matches on:

```
music/
└── <your-user-uuid>/
    ├── albums/
    │   └── <album-uuid>/
    │       ├── cover.jpg
    │       ├── 01-first-track.mp3
    │       └── 02-second-track.mp3
    ├── artists/<artist-uuid>/image.jpg
    └── playlists/<playlist-uuid>/cover.jpg
```

Nothing is world-readable. The app mints a short-lived signed URL each time it
needs a file.

---

## Getting music in

### Option A — the import script (recommended)

Reads tags from your local files, uploads the audio and cover art, and creates
the matching database rows.

```bash
cp .env.example .env     # fill in URL, service-role key, your user UUID
npm run import -- ~/Music/SomeAlbum --dry-run   # preview, writes nothing
npm run import -- ~/Music/SomeAlbum             # do it
```

It reads ID3 / Vorbis / MP4 tags for title, artist, album, track number, year,
genre and duration, pulls embedded cover art (falling back to `cover.jpg` in the
folder), and is safe to re-run — already-imported files are skipped rather than
duplicated.

This script runs **on your machine only**. It uses the service-role key, which
is why `.env` is gitignored and never bundled into the site.

### Option B — by hand

Upload files through the Supabase Storage UI following the layout above, then
insert rows into `artists`, `albums` and `tracks`. `tracks.audio_path` must
match the object key exactly.

---

## Architecture

The four concerns the brief called out are four independent modules. None of
them import each other's internals, and none of the UI code touches Supabase
directly.

```
src/lib/
├── connection/        Supabase connection management
│   ├── config.ts        validation; rejects privileged keys
│   ├── storage.ts       localStorage persistence
│   └── manager.ts       THE only createClient() call in the app
├── library/           the music catalog
│   ├── types.ts         domain types mirroring the SQL schema
│   ├── service.ts       every database query lives here
│   └── artwork.ts       artwork resolution + batched signing
├── player/            playback
│   ├── queue.ts         pure queue model (shuffle/repeat/next/prev)
│   ├── engine.ts        the single <audio> element and its state
│   ├── urls.ts          signed-URL cache with early refresh
│   └── mediaSession.ts  lock-screen metadata
├── state/store.ts     ~40-line observable store
└── ui/                rendering, bound to the stores above
```

A few decisions worth explaining:

**One audio element, created once.** Swapping tracks changes `src` rather than
building a new element. A fresh element would lose iOS's "started by a user
gesture" permission and need another tap to play.

**Playback survives navigation.** The `<audio>` element and the player chrome
are marked `transition:persist`, so Astro's `ClientRouter` carries the same DOM
nodes into the next page instead of recreating them. This is verified by an
end-to-end test that plays audio across a four-screen tour and asserts the
position keeps advancing.

**Signed URLs refresh early.** URLs are cached and treated as stale at 80% of
their lifetime — a ~12-minute margin on a 1-hour URL, comfortably longer than
any single track. If a URL dies anyway, the engine re-signs once and resumes at
the same position rather than dropping you back to silence.

**Shuffle keeps the real order.** The track list is never mutated; a separate
order array is. Toggling shuffle off mid-album puts you back in album order, at
the song you're actually hearing.

**Detail pages use query params** (`/album?id=…`), not dynamic routes. The site
is built statically with no knowledge of any library, so there are no paths to
pre-render.

---

## Security model

What gets stored in your browser, and what doesn't:

| Stored in `localStorage` | Never stored |
|---|---|
| Project URL | Your password |
| Publishable (anon) key | Any service-role or secret key |
| Bucket name | Signed URLs (in-memory only, expire in an hour) |
| Playback preferences | |

The auth session is handled by the Supabase client itself, which persists and
refreshes its own tokens — this app doesn't manage them.

The publishable key is *public configuration*, not a secret. It identifies your
project and grants exactly what your RLS policies allow, which is why the
policies in `0002_rls.sql` matter more than the key does. They restrict every
table to `owner_id = auth.uid()` and grant nothing at all to anonymous users.

"Remember this connection" is opt-in, explains what it saves, and can be undone
from Settings → *Disconnect and clear saved settings*, which also clears the
stored session.

---

## Deployment

The build output is plain static files, deployable anywhere.

```bash
npm run build        # -> dist/
npm run preview      # check the production build locally
```

| Host | How |
|---|---|
| Vercel | Import the repo. Framework preset: Astro. Nothing else to configure. |
| Netlify | Build `npm run build`, publish `dist`. |
| Cloudflare Pages | Build `npm run build`, output `dist`. |
| Any static host | Upload `dist/`. |

**Serve over HTTPS.** Service workers, `Add to Home Screen` and the Media
Session API all require a secure context (`localhost` is exempt for development).

**Set the host's Node version to 22.12 or newer.** Astro 7 requires it, and
`package.json` declares it under `engines` — Vercel, Netlify and Cloudflare
Pages all read that field, but older projects may have a Node version pinned
in their dashboard that overrides it.

There are no environment variables to set at build time. Connection details are
entered by each visitor at runtime, which is what makes one deployment reusable.

### Installing on iPhone

Open the site in Safari → Share → **Add to Home Screen**. It launches
full-screen with its own icon.

---

## Letting other people use it

Nothing to build — this already works. Send someone your deployed URL and
they:

1. Open it and get the same onboarding screen you did.
2. Enter **their own** Supabase project URL, publishable key and bucket.
3. Sign in as a user in **their** project and see **their** library.

Their credentials live in their browser's `localStorage` and are sent only to
their own Supabase project. Nothing routes through yours, and there is no
account system here to sign up for. They will need to do the one-time
[Supabase setup](#supabase-setup) — migrations, a user, a bucket — in a
project they control.

A couple of things this deliberately is *not*:

**It is not a way to share your music with someone.** They get the player,
not your library. Giving someone access to your collection is a different
thing with real consequences — Storage egress is billed to you, and sharing a
personal collection is distribution rather than personal use. The schema could
support it (every row already carries `owner_id`), but the app does not, and
adding it is a deliberate decision rather than a config change.

**It does not need a central user database.** There is no server here holding
anyone's credentials, which is what makes a leak of other people's data
structurally impossible rather than merely unlikely. If you ever do add
multi-user sharing, keep it inside one Supabase project using `owner_id` and
Row Level Security — do not build a service that stores other people's
Supabase keys.

---

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Dev server on :4321 |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the unit test suite |
| `npm run test:e2e` | Browser suite (needs a build first) |
| `npm run test:all` | Unit tests, then build, then browser suite |
| `npm run check` | Astro + TypeScript diagnostics |
| `npm run import -- <dir>` | Import a music folder |
| `npm run icons` | Regenerate the PWA icons |

---

## Known limitations

These are real constraints, stated honestly rather than papered over.

**Audio formats.** Safari plays MP3, AAC/M4A, ALAC, WAV and AIFF. It does
**not** play FLAC, Ogg Vorbis or Opus. The importer warns you when it sees one
of those; convert them to AAC or ALAC. Unsupported files produce a clear error
in the player rather than silent failure.

**Background playback has not been verified on a physical iPhone.** iOS
generally continues audio when the screen locks once playback has started from a
user gesture, and the Media Session API is wired up for lock-screen metadata and
controls. But this was developed and tested in a Linux environment, so:

- Verified in headless Chromium: playback, seeking, auto-advance at track end,
  queue behaviour, recovery from expired URLs, and audio surviving in-app
  navigation.
- **Not verified:** lock-screen artwork and controls on real iOS, behaviour when
  the screen locks, behaviour when the PWA is backgrounded, and whether iOS
  suspends the audio context after long periods.

Please run through `docs/TESTING.md` on your actual phone before relying on it.

**Volume control is hidden on iOS** because `HTMLMediaElement.volume` is
read-only there — volume is hardware-only. Showing a slider would be a dead
control, so the app hides it rather than lying.

**`setPositionState` is not implemented in Safari**, so the Control Center
scrubber may not track position even though metadata and transport controls do.

**Offline playback is not implemented**, by design. The service worker caches
the app shell only; audio and API responses are never cached. Signed URLs
expire, so a cached response would break playback rather than help.

**Range requests** are handled by Supabase Storage, so seeking within a track
does not re-download it.

---

## Testing

```bash
npm test
```

153 unit tests covering the parts where a bug is expensive:

| Area | What's covered |
|---|---|
| Queue | shuffle/repeat semantics, wrap-around, insertion, removal |
| Signed URLs | caching, request coalescing, early refresh, eviction, failure |
| Connection | validation, privileged-key rejection, persistence, corrupt data |
| Playback | transitions, auto-advance, URL-failure recovery, history recording |
| Library | query construction, pagination, error mapping |
| Errors | every Supabase failure mode maps to actionable advice |

### Browser tests

```bash
npm run test:all        # unit -> build -> browser
```

`tests/e2e/` drives the real built app in headless Chromium at a 393x852
iPhone viewport against a mocked Supabase project that serves real audio and
real artwork. 72 checks across four suites:

| Suite | Covers |
|---|---|
| `onboarding.mjs` | Validation, connection test, service-role key refusal |
| `player.mjs` | Every screen, real playback, seek, auto-advance, queue, expired-URL recovery, audio surviving a four-screen navigation tour |
| `error-states.mjs` | Missing tables, expired session, empty library, missing audio file, unreachable project |
| `gate-fields.mjs` | A restored config repopulates the form; typing survives a failed connect |

Playwright needs a browser once: `npx playwright install chromium`. If your
environment already ships one, point at it with `PLAYWRIGHT_EXECUTABLE_PATH`.

Screenshots are written to `tests/e2e/shots/`.

See `docs/TESTING.md` for the manual iPhone checklist — including the things
that **cannot** be verified without the physical device.
