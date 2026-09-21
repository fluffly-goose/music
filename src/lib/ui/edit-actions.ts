/**
 * The "edit this" flows: track, album and artist.
 *
 * Each builds an edit sheet, saves through the library service, and tells the
 * caller to refresh. Artwork changes upload to a fresh key rather than
 * overwriting the old one, so a cached signed URL can never keep serving the
 * previous image.
 */

import { library } from '../library/service';
import { connection } from '../connection/manager';
import { removeFolder, removeObject, removeObjects, uploadObject } from '../library/storage';
import { signedUrls } from '../player/urls';
import { artworkUrl, placeholderArtwork } from '../library/artwork';
import { player } from '../player/engine';
import type { Album, Artist, Track } from '../library/types';
import { trackArtistName } from '../library/types';
import { openEditSheet, artworkHeader } from './edit-sheet';
import { showToast } from './render';
import { escapeHtml, pluralize } from '../utils/format';
import { AppError } from '../utils/errors';

/** "" -> null, "1998" -> 1998, "abc" -> null. */
function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTextOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Wires the artwork picker inside a sheet. Returns a getter for the chosen
 * file, so the upload happens on save rather than on selection — picking an
 * image then cancelling should change nothing.
 */
function mountArtworkPicker(panel: HTMLElement): () => File | null {
  let chosen: File | null = null;
  const button = panel.querySelector<HTMLElement>('[data-art-picker]');
  const input = panel.querySelector<HTMLInputElement>('[data-art-input]');
  const preview = button?.querySelector('img');

  button?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      showToast('Pick a PNG, JPEG or WebP image', 'error');
      return;
    }
    chosen = file;
    if (preview) preview.src = URL.createObjectURL(file);
  });

  return () => chosen;
}

/** Uploads new artwork under a fresh key and returns that key. */
async function replaceArtwork(
  file: File,
  folder: string,
  previousPath: string | null,
): Promise<string> {
  const extension = file.type === 'image/png' ? '.png' : file.type === 'image/webp' ? '.webp' : '.jpg';
  // A new key each time: overwriting would leave cached signed URLs (and any
  // CDN copy) serving the old image.
  const path = `${folder}/cover-${Date.now()}${extension}`;
  await uploadObject(path, file, { contentType: file.type, upsert: true });
  if (previousPath && previousPath !== path) {
    signedUrls.invalidate(connection.getBucket(), previousPath);
    await removeObject(previousPath);
  }
  return path;
}

function requireOwner(): string {
  const ownerId = connection.getOwnerId();
  if (!ownerId) {
    throw new AppError('auth-required', 'Sign in to edit your library.', {
      hint: 'Your library is protected by Row Level Security.',
    });
  }
  return ownerId;
}


/* -------------------------------------------------------------------------- */
/* Shared entity handling                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Find-or-create, the same rule the importer uses. An empty name means "no
 * artist", which the schema allows.
 */
async function resolveArtist(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = await library.findArtistByName(trimmed);
  return existing ? existing.id : (await library.createArtist(trimmed)).id;
}

async function resolveAlbum(
  title: string,
  artistId: string | null,
  hints: { year?: number | null; genre?: string | null } = {},
): Promise<string | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const existing = await library.findAlbum(trimmed, artistId);
  if (existing) return existing.id;
  return (await library.createAlbum({
    title: trimmed,
    artistId,
    year: hints.year ?? null,
    genre: hints.genre ?? null,
  })).id;
}

/**
 * Removes artists and albums that a move just emptied out.
 *
 * Both are created implicitly by importing and editing, so without this a
 * library slowly fills with ghost entries holding nothing. Best-effort: a
 * failure here must never undo the edit that already succeeded.
 */
async function pruneOrphans(options: {
  artistIds?: (string | null | undefined)[];
  albumIds?: (string | null | undefined)[];
}): Promise<void> {
  const ownerId = connection.getOwnerId();

  for (const albumId of new Set((options.albumIds ?? []).filter(Boolean) as string[])) {
    try {
      if ((await library.getAlbumTrackCount(albumId)) > 0) continue;
      const album = await library.getAlbum(albumId);
      await library.deleteAlbum(albumId);
      if (album?.cover_path) {
        signedUrls.invalidate(connection.getBucket(), album.cover_path);
        await removeObject(album.cover_path);
      }
      if (ownerId) await removeFolder(`${ownerId}/albums/${albumId}`);
    } catch (error) {
      console.warn('[edit] could not prune empty album', albumId, error);
    }
  }

  for (const artistId of new Set((options.artistIds ?? []).filter(Boolean) as string[])) {
    try {
      const usage = await library.getArtistUsage(artistId);
      if (usage.albums === 0 && usage.tracks === 0) await library.deleteArtist(artistId);
    } catch (error) {
      console.warn('[edit] could not prune empty artist', artistId, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Track                                                                       */
/* -------------------------------------------------------------------------- */

export async function editTrack(track: Track, onSaved?: () => void | Promise<void>): Promise<void> {
  await openEditSheet({
    title: 'Edit song',
    fields: [
      { name: 'title', label: 'Title', value: track.title, required: true, maxLength: 200 },
      {
        name: 'artist',
        label: 'Artist',
        value: trackArtistName(track) === 'Unknown Artist' ? '' : trackArtistName(track),
        maxLength: 200,
        placeholder: 'Unknown Artist',
      },
      {
        name: 'album',
        label: 'Album',
        value: track.album?.title ?? '',
        maxLength: 200,
        placeholder: 'No album',
        hint: 'Changing the artist or album moves just this song. A name that does not exist yet is created.',
      },
      { name: 'track_no', label: 'Track', value: track.track_no, placeholder: '—', inputMode: 'numeric' },
      { name: 'disc_no', label: 'Disc', value: track.disc_no, placeholder: '1', inputMode: 'numeric' },
      { name: 'year', label: 'Year', value: track.year, placeholder: '—', inputMode: 'numeric' },
      { name: 'genre', label: 'Genre', value: track.genre, placeholder: '—', maxLength: 80 },
    ],
    danger: {
      label: 'Delete song',
      confirm: `Delete "${track.title}"? The audio file is removed from storage too. This cannot be undone.`,
      onSelect: async () => {
        const audioPath = track.audio_path;
        await library.deleteTrack(track.id);
        // Row first, then bytes: an orphaned object is recoverable, a row
        // pointing at a deleted file is not.
        signedUrls.invalidate(connection.getBucket(), audioPath);
        await removeObject(audioPath);
        if (player.store.get().track?.id === track.id) player.reset();
        showToast('Song deleted');
        // Deleting the last song of an album leaves a shell behind otherwise.
        await pruneOrphans({ artistIds: [track.artist_id], albumIds: [track.album_id] });
        await onSaved?.();
      },
    },
    onSubmit: async (values) => {
      requireOwner();

      const patch: Parameters<typeof library.updateTrack>[1] = {
        title: values.title!,
        track_no: toNumberOrNull(values.track_no ?? ''),
        disc_no: toNumberOrNull(values.disc_no ?? ''),
        year: toNumberOrNull(values.year ?? ''),
        genre: toTextOrNull(values.genre ?? ''),
      };

      const previousArtistId = track.artist_id;
      const previousAlbumId = track.album_id;

      const artistName = (values.artist ?? '').trim();
      const albumTitle = (values.album ?? '').trim();
      const artistChanged = artistName !== (trackArtistName(track) === 'Unknown Artist' ? '' : trackArtistName(track));
      const albumChanged = albumTitle !== (track.album?.title ?? '');

      let artistId = previousArtistId;
      if (artistChanged) {
        artistId = await resolveArtist(artistName);
        patch.artist_id = artistId;
      }
      if (albumChanged || (artistChanged && albumTitle)) {
        // The album is looked up under the song's artist, so two artists can
        // each have an album of the same name without colliding.
        patch.album_id = await resolveAlbum(albumTitle, artistId, {
          year: patch.year,
          genre: patch.genre,
        });
      }

      await library.updateTrack(track.id, patch);

      if (artistChanged || albumChanged) {
        await pruneOrphans({
          artistIds: [previousArtistId],
          albumIds: [previousAlbumId],
        });
      }

      showToast('Song updated');
      await onSaved?.();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Album                                                                       */
/* -------------------------------------------------------------------------- */

export async function editAlbum(album: Album, onSaved?: () => void | Promise<void>): Promise<void> {
  const ownerId = requireOwner();
  const currentArt = await artworkUrl({ path: album.cover_path, seed: album.title });
  let getArtwork: () => File | null = () => null;

  await openEditSheet({
    title: 'Edit album',
    header: artworkHeader({ src: currentArt, label: 'Change album artwork' }),
    onMount: (panel) => { getArtwork = mountArtworkPicker(panel); },
    fields: [
      { name: 'title', label: 'Title', value: album.title, required: true, maxLength: 200 },
      {
        name: 'artist',
        label: 'Artist',
        value: album.artist?.name ?? '',
        maxLength: 200,
        hint: 'Typing a new name creates that artist. An existing name moves the album to them.',
      },
      { name: 'year', label: 'Year', value: album.year, placeholder: '—', inputMode: 'numeric' },
      { name: 'genre', label: 'Genre', value: album.genre, placeholder: '—', maxLength: 80 },
    ],
    danger: {
      label: 'Delete album',
      confirm:
        `Delete "${album.title}" and all of its songs? ` +
        'The audio files are removed from storage too. This cannot be undone.',
      onSelect: async () => {
        // Collect paths before the rows cascade away. Removing exactly these,
        // rather than the whole folder, matters once songs can move between
        // albums: a moved-out track keeps its original object key, and wiping
        // the folder would delete a file another album still points at.
        const paths = await library.getAlbumAudioPaths(album.id);
        if (album.cover_path) paths.push(album.cover_path);
        await library.deleteAlbum(album.id);
        for (const path of paths) signedUrls.invalidate(connection.getBucket(), path);
        await removeObjects(paths);
        if (player.store.get().track?.album_id === album.id) player.reset();
        showToast('Album deleted');
        await pruneOrphans({ artistIds: [album.artist_id] });
        await onSaved?.();
      },
    },
    onSubmit: async (values) => {
      const patch: Parameters<typeof library.updateAlbum>[1] = {
        title: values.title!,
        year: toNumberOrNull(values.year ?? ''),
        genre: toTextOrNull(values.genre ?? ''),
      };

      // Find-or-create, the same rule the importer uses, so an album's artist
      // can be corrected without leaving the screen.
      const artistName = (values.artist ?? '').trim();
      const previousArtistId = album.artist_id;
      const artistChanged = artistName !== (album.artist?.name ?? '');
      let newArtistId: string | null = previousArtistId;
      if (artistChanged) {
        newArtistId = await resolveArtist(artistName);
        patch.artist_id = newArtistId;
      }

      const file = getArtwork();
      if (file) {
        patch.cover_path = await replaceArtwork(
          file,
          `${ownerId}/albums/${album.id}`,
          album.cover_path,
        );
      }

      await library.updateAlbum(album.id, patch);

      if (artistChanged) {
        // tracks.artist_id is independent of albums.artist_id, so without this
        // every song stays attributed to - and listed under - the old artist.
        await library.setAlbumTracksArtist(album.id, newArtistId);
        await pruneOrphans({ artistIds: [previousArtistId] });
      }

      showToast('Album updated');
      await onSaved?.();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Artist                                                                      */
/* -------------------------------------------------------------------------- */

export async function editArtist(artist: Artist, onSaved?: () => void | Promise<void>): Promise<void> {
  const ownerId = requireOwner();
  const [currentArt, usage] = await Promise.all([
    artworkUrl({ path: artist.image_path, seed: artist.name }),
    library.getArtistUsage(artist.id),
  ]);
  let getArtwork: () => File | null = () => null;

  // An artist is a shared record, so a rename is not a local edit. Say so
  // before it happens rather than surprising someone afterwards.
  const scope =
    usage.albums + usage.tracks > 0
      ? `<div class="rounded-xl p-3 mb-4 text-[13px] leading-relaxed"
              style="background:var(--surface-2); color:var(--muted)">
           Renaming updates this artist everywhere — ${escapeHtml(pluralize(usage.albums, 'album'))}
           and ${escapeHtml(pluralize(usage.tracks, 'song'))}.
         </div>`
      : '';

  await openEditSheet({
    title: 'Edit artist',
    header: artworkHeader({ src: currentArt, round: true, label: 'Change artist photo' }) + scope,
    onMount: (panel) => { getArtwork = mountArtworkPicker(panel); },
    fields: [
      { name: 'name', label: 'Name', value: artist.name, required: true, maxLength: 200 },
      { name: 'bio', label: 'About', value: artist.bio, type: 'textarea', placeholder: 'Optional', maxLength: 2000 },
    ],
    onSubmit: async (values) => {
      const patch: Parameters<typeof library.updateArtist>[1] = {
        name: values.name!,
        bio: toTextOrNull(values.bio ?? ''),
      };

      const file = getArtwork();
      if (file) {
        patch.image_path = await replaceArtwork(
          file,
          `${ownerId}/artists/${artist.id}`,
          artist.image_path,
        );
      }

      await library.updateArtist(artist.id, patch);
      showToast('Artist updated');
      await onSaved?.();
    },
  });
}

export { placeholderArtwork };
