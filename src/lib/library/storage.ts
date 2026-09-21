/**
 * Storage writes.
 *
 * The read side lives in player/urls.ts (signed URLs); this is its counterpart
 * for putting bytes in. Both go through the *authenticated* client, so the
 * bucket policies in 0003_storage.sql are what actually authorise every call:
 * an object key must begin with the uploader's own user id.
 *
 * Nothing here needs, or is given, a privileged key.
 */

import { connection } from '../connection/manager';
import { AppError, toAppError } from '../utils/errors';

/**
 * Matches the `file_size_limit` set on the bucket in 0003_storage.sql.
 * Checked client-side so a 300 MB file fails in a millisecond with a clear
 * message instead of after a long upload.
 */
export const MAX_OBJECT_BYTES = 200 * 1024 * 1024;

export interface UploadOptions {
  contentType?: string;
  /** Replace an object at the same key instead of failing. */
  upsert?: boolean;
  signal?: AbortSignal;
}

/** Uploads one object and returns the key it was stored under. */
export async function uploadObject(
  path: string,
  body: File | Blob | ArrayBuffer | Uint8Array,
  options: UploadOptions = {},
): Promise<string> {
  const client = connection.requireClient();
  const bucket = connection.getBucket();

  const size =
    body instanceof Blob
      ? body.size
      : body instanceof ArrayBuffer
        ? body.byteLength
        : body.byteLength;

  if (size > MAX_OBJECT_BYTES) {
    throw new AppError('upload', 'That file is too large to upload.', {
      hint: `The bucket accepts files up to ${Math.round(MAX_OBJECT_BYTES / 1024 / 1024)} MB. Raise the bucket's file size limit in Supabase if you need more.`,
    });
  }

  try {
    const { error } = await client.storage.from(bucket).upload(path, body, {
      contentType: options.contentType,
      upsert: options.upsert ?? false,
      cacheControl: '3600',
    });

    if (error) {
      const mapped = toAppError(error, undefined);
      // A duplicate key is a normal outcome when re-importing, not a failure
      // worth dressing up as something scarier.
      if (/already exists|duplicate/i.test(mapped.userMessage)) {
        throw new AppError('upload', 'A file is already stored at that location.', {
          hint: 'It looks like this track was imported before.',
          cause: error,
        });
      }
      if (mapped.kind === 'unknown') {
        throw new AppError('upload', 'Could not upload that file.', {
          hint: `Check that the "${bucket}" bucket exists and that you are signed in as the library owner.`,
          cause: error,
        });
      }
      throw mapped;
    }

    return path;
  } catch (raw) {
    throw toAppError(raw, undefined);
  }
}

/**
 * Best-effort delete, used to roll back an uploaded file when the database row
 * that should point at it could not be written. Without this a failed import
 * would silently leave orphaned audio in the bucket.
 */
export async function removeObject(path: string): Promise<void> {
  const client = connection.getClient();
  if (!client) return;
  try {
    await client.storage.from(connection.getBucket()).remove([path]);
  } catch (error) {
    console.warn('[storage] could not clean up', path, error);
  }
}
