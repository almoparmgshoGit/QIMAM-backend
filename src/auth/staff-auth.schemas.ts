import { z } from 'zod';

export const passwordSchema = z.string().min(12).max(128);
const totpCode = z.string().regex(/^\d{6}$/);
const jwtToken = z.string().max(1024);

export const staffLoginSchema = z.strictObject({
  identifier: z.string().trim().min(3).max(254),
  // Shorter than the policy on purpose: older passwords must still reach the check, not fail on shape.
  password: z.string().min(1).max(128),
});
export type StaffLoginDto = z.infer<typeof staffLoginSchema>;

export const mfaTokenSchema = z.strictObject({ mfaToken: jwtToken });

export const impersonationTicketSchema = z.strictObject({ ticket: jwtToken });
export type ImpersonationTicketDto = z.infer<typeof impersonationTicketSchema>;
export type MfaTokenDto = z.infer<typeof mfaTokenSchema>;

export const mfaCodeSchema = z.strictObject({ mfaToken: jwtToken, code: totpCode });
export type MfaCodeDto = z.infer<typeof mfaCodeSchema>;

export const setPasswordSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: passwordSchema,
});
export type SetPasswordDto = z.infer<typeof setPasswordSchema>;

export const forgotPasswordSchema = z.strictObject({ email: z.email().max(254) });
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
