import { ApiError } from '../common/api-error.js';

/** Every badge picture is a square PNG of this size. The dashboard scales larger pictures down before upload. */
export const BADGE_IMAGE_SIZE = 256;
export const MAX_BADGE_IMAGE_BYTES = 512 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Checks the file is really a PNG of the agreed size, from its own header rather than the name or type the
 * browser sent, so nothing else is ever stored or served as a badge.
 */
export function assertBadgePng(file: { buffer: Buffer } | undefined): Buffer {
  if (!file) throw new ApiError(400, 'file_required');
  const data = file.buffer;
  if (data.length > MAX_BADGE_IMAGE_BYTES) throw new ApiError(413, 'payload_too_large');
  // The signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ApiError(400, 'unsupported_file_type');
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== BADGE_IMAGE_SIZE || height !== BADGE_IMAGE_SIZE) throw new ApiError(400, 'invalid_image_size');
  return data;
}
