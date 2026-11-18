import { z } from 'zod';
import { idSchema, pageFields } from '../common/staff-api.js';

const MB = 1024 * 1024;

/** About 30 minutes of the app's recording quality (mono AAC, 64 kbps), with room to spare. */
export const MAX_RECORDING_BYTES = 20 * MB;
export const MAX_RECORDING_MS = 30 * 60 * 1000;
/** Recordings a student may have waiting at once, so the queue can't fill with retries. */
export const MAX_PENDING_RECORDINGS = 10;

// Sent as multipart form fields next to the file, so they arrive as text.
export const uploadRecordingSchema = z
  .strictObject({
    surah: z.coerce.number().int().min(1).max(114),
    fromAyah: z.coerce.number().int().min(1).max(286),
    toAyah: z.coerce.number().int().min(1).max(286),
    durationMs: z.coerce.number().int().min(1000).max(MAX_RECORDING_MS),
  })
  .refine((value) => value.fromAyah <= value.toAyah, { path: ['toAyah'], message: 'toAyah must not come before fromAyah' });
export type UploadRecordingDto = z.infer<typeof uploadRecordingSchema>;

export const listRecordingsSchema = z.strictObject({
  ...pageFields,
  status: z.enum(['pending', 'reviewed']).optional(),
  studentId: idSchema.optional(),
});
export type ListRecordingsDto = z.infer<typeof listRecordingsSchema>;

/** The evaluation of a recording. What was recited is the recording's own range. */
export const evaluateRecordingSchema = z.strictObject({
  score: z.number().min(0).max(10),
  note: z.string().trim().max(1000).optional(),
  segmentStatus: z.enum(['NEEDS_REVIEW', 'MASTERED']).nullable(),
});
export type EvaluateRecordingDto = z.infer<typeof evaluateRecordingSchema>;
