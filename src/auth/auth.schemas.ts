import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

const AGE_BANDS = ['15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25+'] as const;

/** Accepts the international format and stores E.164, so one number can only ever be one account. */
export const phoneSchema = z
  .string()
  .trim()
  .max(24)
  .transform((value, ctx) => {
    const parsed = parsePhoneNumberFromString(value);
    if (!parsed?.isValid()) {
      ctx.addIssue({ code: 'custom', message: 'invalid phone number' });
      return z.NEVER;
    }
    return parsed.number;
  });

/** A track's code. Tracks are added by the administrator, so the database decides which ones exist. */
export const trackSchema = z.string().trim().min(1).max(40);
export const trackStartSchema = z.enum(['kahf', 'fatiha']);

const registrationFields = {
  fullName: z
    .string()
    .trim()
    .max(120)
    .refine((name) => name.split(/\s+/).length >= 3, 'full name must have three parts')
    // Letters, marks and spaces in any language: no markup and no control characters.
    .refine((name) => /^[\p{L}\p{M}\s'’-]+$/u.test(name), 'full name has invalid characters'),
  country: z.string().trim().min(1).max(80),
  ageBand: z.enum(AGE_BANDS),
  trackId: trackSchema,
  trackStart: trackStartSchema.nullable(),
  pledgesAccepted: z.literal(true),
};

const trackStartMatchesTrack = (data: { trackId: string; trackStart: string | null }) =>
  (data.trackId === 'stabilization') === (data.trackStart !== null);
const TRACK_START_ERROR = { message: 'trackStart goes with the stabilization track only', path: ['trackStart'] };

const registrationSchema = z.strictObject(registrationFields).refine(trackStartMatchesTrack, TRACK_START_ERROR);
export type RegistrationDto = z.infer<typeof registrationSchema>;

// There is no phone field: the number comes from the token, which proves it was verified.
export const completeRegistrationSchema = z
  .strictObject({ registrationToken: z.string().max(1024), ...registrationFields })
  .refine(trackStartMatchesTrack, TRACK_START_ERROR);
export type CompleteRegistrationDto = z.infer<typeof completeRegistrationSchema>;

export const requestOtpSchema = z.strictObject({
  phone: phoneSchema,
  purpose: z.enum(['login', 'register']),
});
export type RequestOtpDto = z.infer<typeof requestOtpSchema>;

export const verifyOtpSchema = z.strictObject({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
  registration: registrationSchema.optional(),
});
export type VerifyOtpDto = z.infer<typeof verifyOtpSchema>;

export const refreshTokenSchema = z.strictObject({
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type RefreshTokenDto = z.infer<typeof refreshTokenSchema>;
