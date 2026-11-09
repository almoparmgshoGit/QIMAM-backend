import { z } from 'zod';
import { trackSchema, trackStartSchema } from '../auth/auth.schemas.js';

/** A name the server itself can use, so one bad value can't reach the reminder job. */
const timeZoneSchema = z
  .string()
  .max(60)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone');

// Strict at every level: fields such as role, status or phone are rejected, not silently dropped.
export const updateProfileSchema = z
  .strictObject({
    track: z
      .strictObject({ trackId: trackSchema, trackStart: trackStartSchema.nullable() })
      .refine((track) => (track.trackId === 'stabilization') === (track.trackStart !== null), {
        message: 'trackStart goes with the stabilization track only',
        path: ['trackStart'],
      })
      .optional(),
    preferences: z
      .strictObject({
        language: z.enum(['ar', 'en']).optional(),
        timeZone: timeZoneSchema.optional(),
        reminderMinutes: z.number().int().min(0).max(1439).optional(),
        notifications: z
          .strictObject({
            dailyWird: z.boolean().optional(),
            weeklyReview: z.boolean().optional(),
            newTask: z.boolean().optional(),
            evaluation: z.boolean().optional(),
            badges: z.boolean().optional(),
            general: z.boolean().optional(),
            encouragement: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .refine((changes) => changes.track !== undefined || changes.preferences !== undefined, 'nothing to update');

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
