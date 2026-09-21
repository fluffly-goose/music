#!/usr/bin/env node
/**
 * Imports a local music folder into your Supabase project.
 *
 * Runs on YOUR machine, never in a browser, because it needs the service-role
 * key to write rows and upload objects on your behalf. That key must never be
 * deployed with the website.
 *
 *   cp .env.example .env    # then fill it in
 *   npm run import -- ~/Music/MyAlbums
 *   npm run import -- ~/Music --dry-run
 *
 * It reads ID3/Vorbis/MP4 tags to fill in artist, album, track number, year
 * and duration, extracts embedded cover art, and is safe to re-run: existing
 * artists, albums and tracks are matched rather than duplicated.
 */

import { createClient } from '@supabase/supabase-js';
import { parseFile } from 'music-metadata';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.aiff', '.aif', '.flac', '.ogg', '.opus']);
/** Formats Safari cannot decode. Imported anyway, but flagged loudly. */
const SAFARI_UNSUPPORTED = new Set(['.flac', '.ogg', '.opus']);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'artwork'];
const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus',
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceDir = args.find((a) => !a.startsWith('--'));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_OWNER_ID } = process.env;
const BUCKET = process.env.SUPABASE_BUCKET || 'music';

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!sourceDir) {
  fail('Usage: npm run import -- <folder> [--dry-run]');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_OWNER_ID) {
  fail(
    'Missing configuration. Copy .env.example to .env and set SUPABASE_URL,\n' +
    '  SUPABASE_SERVICE_ROLE_KEY and SUPABASE_OWNER_ID.\n' +
    '  SUPABASE_OWNER_ID is your user id from Authentication -> Users.',
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* -------------------------------------------------------------------------- */

function slugify(value) {
  return (
    String(value)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    console.warn(`  ! could not read ${dir}: ${error.message}`);
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** Finds cover.jpg / folder.png etc. sitting next to the audio files. */
async function findFolderCover(dir) {
  try {
    for (const entry of await readdir(dir)) {
      const ext = extname(entry).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue;
      if (COVER_NAMES.includes(basename(entry, ext).toLowerCase())) return join(dir, entry);
    }
  } catch { /* ignore */ }
  return null;
}

/* -- caches so a 500-track import does not re-query per file ---------------- */
const artistCache = new Map();
const albumCache = new Map();

async function upsertArtist(name) {
  const key = name.toLowerCase();
  if (artistCache.has(key)) return artistCache.get(key);

  const { data: existing } = await supabase
    .from('artists').select('id')
    .eq('owner_id', SUPABASE_OWNER_ID).eq('name', name).maybeSingle();

  if (existing) {
    artistCache.set(key, existing.id);
    return existing.id;
  }

  const { data, error } = await supabase
    .from('artists').insert({ owner_id: SUPABASE_OWNER_ID, name }).select('id').single();
  if (error) throw new Error(`creating artist "${name}": ${error.message}`);

  artistCache.set(key, data.id);
  return data.id;
}

async function upsertAlbum(title, artistId, year, genre) {
  const key = `${artistId}::${title.toLowerCase()}`;
  if (albumCache.has(key)) return albumCache.get(key);

  let query = supabase
    .from('albums').select('id, cover_path')
    .eq('owner_id', SUPABASE_OWNER_ID).eq('title', title);
  query = artistId ? query.eq('artist_id', artistId) : query.is('artist_id', null);

  const { data: existing } = await query.maybeSingle();
  if (existing) {
    albumCache.set(key, existing);
    return existing;
  }

  const { data, error } = await supabase
    .from('albums')
    .insert({ owner_id: SUPABASE_OWNER_ID, title, artist_id: artistId, year: year ?? null, genre: genre ?? null })
    .select('id, cover_path').single();
  if (error) throw new Error(`creating album "${title}": ${error.message}`);

  albumCache.set(key, data);
  return data;
}

async function uploadObject(path, body, contentType) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, body, { contentType, upsert: true, cacheControl: '3600' });
  if (error) throw new Error(`uploading ${path}: ${error.message}`);
  return path;
}

/* -------------------------------------------------------------------------- */

async function main() {
  const root = resolve(sourceDir);
  try {
    if (!(await stat(root)).isDirectory()) fail(`${root} is not a directory.`);
  } catch {
    fail(`${root} does not exist.`);
  }

  console.log(`\nScanning ${root}…`);
  const files = await walk(root);
  if (files.length === 0) fail('No audio files found.');
  console.log(`Found ${files.length} audio file(s).${dryRun ? '  [dry run — nothing will be written]' : ''}\n`);

  // Verify the bucket exists before uploading hundreds of megabytes into nothing.
  if (!dryRun) {
    const { error } = await supabase.storage.from(BUCKET).list('', { limit: 1 });
    if (error) {
      fail(`Bucket "${BUCKET}" is not reachable: ${error.message}\n  Run supabase/migrations/0003_storage.sql first.`);
    }
  }

  let imported = 0, skipped = 0, failed = 0;
  const warnings = [];
  const coveredAlbums = new Set();

  for (const [index, file] of files.entries()) {
    const label = `[${index + 1}/${files.length}] ${basename(file)}`;
    try {
      const metadata = await parseFile(file, { duration: true });
      const common = metadata.common ?? {};
      const format = metadata.format ?? {};

      const title = common.title?.trim() || basename(file, extname(file));
      const artistName = (common.artist || common.albumartist || '').trim() || 'Unknown Artist';
      const albumTitle = (common.album || '').trim() || 'Unknown Album';
      const ext = extname(file).toLowerCase();

      if (SAFARI_UNSUPPORTED.has(ext)) {
        warnings.push(`${basename(file)} is ${ext} — Safari cannot play this; convert to AAC (.m4a) or MP3.`);
      }

      if (dryRun) {
        console.log(`${label}\n    ${artistName} — ${albumTitle} — ${title} (${Math.round(format.duration ?? 0)}s)`);
        imported++;
        continue;
      }

      const artistId = await upsertArtist(artistName);
      const album = await upsertAlbum(albumTitle, artistId, common.year, common.genre?.[0]);

      const audioPath =
        `${SUPABASE_OWNER_ID}/albums/${album.id}/` +
        `${String(common.track?.no ?? index + 1).padStart(2, '0')}-${slugify(title)}${ext}`;

      // Re-runnable: an existing row for this exact object is left alone.
      const { data: existingTrack } = await supabase
        .from('tracks').select('id')
        .eq('owner_id', SUPABASE_OWNER_ID).eq('audio_path', audioPath).maybeSingle();
      if (existingTrack) {
        console.log(`${label}  — already imported, skipping`);
        skipped++;
        continue;
      }

      const bytes = await readFile(file);
      await uploadObject(audioPath, bytes, MIME[ext] ?? 'application/octet-stream');

      // Cover art: embedded picture first, then a cover file in the folder.
      if (!album.cover_path && !coveredAlbums.has(album.id)) {
        let coverBytes = null;
        let coverExt = '.jpg';
        const picture = common.picture?.[0];
        if (picture) {
          coverBytes = Buffer.from(picture.data);
          coverExt = picture.format?.includes('png') ? '.png' : '.jpg';
        } else {
          const folderCover = await findFolderCover(join(file, '..'));
          if (folderCover) {
            coverBytes = await readFile(folderCover);
            coverExt = extname(folderCover).toLowerCase();
          }
        }
        if (coverBytes) {
          const coverPath = `${SUPABASE_OWNER_ID}/albums/${album.id}/cover${coverExt}`;
          await uploadObject(coverPath, coverBytes, coverExt === '.png' ? 'image/png' : 'image/jpeg');
          await supabase.from('albums').update({ cover_path: coverPath }).eq('id', album.id);
          album.cover_path = coverPath;
        }
        coveredAlbums.add(album.id);
      }

      const { error: insertError } = await supabase.from('tracks').insert({
        owner_id: SUPABASE_OWNER_ID,
        album_id: album.id,
        artist_id: artistId,
        title,
        track_no: common.track?.no ?? null,
        disc_no: common.disk?.no ?? 1,
        duration_seconds: format.duration ? Number(format.duration.toFixed(3)) : null,
        audio_path: audioPath,
        mime_type: MIME[ext] ?? null,
        file_size: bytes.length,
        genre: common.genre?.[0] ?? null,
        year: common.year ?? null,
      });
      if (insertError) throw new Error(insertError.message);

      console.log(`${label}  ✓ ${artistName} — ${title}`);
      imported++;
    } catch (error) {
      console.error(`${label}  ✗ ${error.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Imported: ${imported}   Skipped: ${skipped}   Failed: ${failed}`);
  if (warnings.length) {
    console.log(`\nFormat warnings (${warnings.length}):`);
    for (const warning of warnings.slice(0, 10)) console.log(`  ! ${warning}`);
    if (warnings.length > 10) console.log(`  … and ${warnings.length - 10} more`);
  }
  console.log('');
}

main().catch((error) => fail(error.message));
