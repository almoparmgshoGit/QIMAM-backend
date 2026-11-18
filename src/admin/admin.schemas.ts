import { z } from 'zod';
import { AGE_BANDS } from '../auth/auth.schemas.js';
import { PERMISSION_KEYS } from '../auth/permissions.js';
import { idSchema, pageFields, phoneField, textField } from '../common/staff-api.js';

const accountStatus = z.enum(['ACTIVE', 'SUSPENDED']);
const staffRole = z.enum(['TEACHER', 'SUPERVISOR', 'ADMIN', 'EMPLOYEE']);
/** The administration works program-wide, so it has no scope. */
const hasNoScope = (role: z.infer<typeof staffRole>) => role === 'ADMIN' || role === 'EMPLOYEE';
const capacity = z.number().int().min(1).max(200);
/** Men teach and supervise the men's section, and women the women's. */
const section = z.enum(['WOMEN', 'MEN']);

const emailField = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

export const createStaffSchema = z
  .strictObject({
    fullName: textField(120),
    email: emailField.optional(),
    phone: phoneField.optional(),
    role: staffRole,
    // The column's own default, for clients that predate the men's section.
    section: section.default('WOMEN'),
    scopeId: idSchema.optional(),
    /** A free circle in the scope for a new teacher to take. */
    circleId: idSchema.optional(),
    /** An employee's rank. */
    rankId: idSchema.optional(),
  })
  .refine((value) => hasNoScope(value.role) === (value.scopeId === undefined), {
    message: 'teachers and supervisors need a scope, and the administration has none',
    path: ['scopeId'],
  })
  .refine((value) => (value.role === 'EMPLOYEE') === (value.rankId !== undefined), {
    message: 'an employee needs a rank, and no one else has one',
    path: ['rankId'],
  })
  .refine((value) => Boolean(value.email ?? value.phone), { message: 'an email or a phone number is required', path: ['email'] })
  .refine((value) => !value.circleId || value.role === 'TEACHER', { message: 'only a teacher takes a circle', path: ['circleId'] });
export type CreateStaffDto = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z
  .strictObject({
    fullName: textField(120).optional(),
    /** Null clears it, as long as the other way in remains. */
    email: emailField.nullable().optional(),
    phone: phoneField.nullable().optional(),
    /** Between teacher and supervisor only. An administrator's role is not changed here. */
    role: z.enum(['TEACHER', 'SUPERVISOR']).optional(),
    section: section.optional(),
    scopeId: idSchema.optional(),
    status: accountStatus.optional(),
    /** An employee's rank. Only an administrator changes it. */
    rankId: idSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateStaffDto = z.infer<typeof updateStaffSchema>;

export const rankSchema = z.strictObject({
  name: textField(80),
  description: textField(300).nullable().optional(),
  permissions: z
    .array(z.enum(PERMISSION_KEYS))
    .max(PERMISSION_KEYS.length)
    .transform((keys) => [...new Set(keys)]),
});
export type RankDto = z.infer<typeof rankSchema>;
export const updateRankSchema = rankSchema.partial().refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateRankDto = z.infer<typeof updateRankSchema>;

export const listStaffSchema = z.strictObject({
  ...pageFields,
  role: staffRole.optional(),
  scopeId: idSchema.optional(),
  status: accountStatus.optional(),
  section: section.optional(),
  /** Matches the name, email or phone. */
  search: z.string().trim().max(120).optional(),
});
export type ListStaffDto = z.infer<typeof listStaffSchema>;

export const scopeSchema = z.strictObject({ name: textField(80) });
export type ScopeDto = z.infer<typeof scopeSchema>;

export const listStudentsSchema = z.strictObject({
  ...pageFields,
  search: z.string().trim().max(120).optional(),
  country: z.string().trim().max(80).optional(),
  trackId: idSchema.optional(),
  section: section.optional(),
  status: z.enum(['active', 'awaitingAssignment', 'suspended']).optional(),
});
export type ListStudentsDto = z.infer<typeof listStudentsSchema>;

export const createStudentSchema = z.strictObject({
  fullName: textField(120),
  phone: phoneField,
  country: textField(80),
  /** Given for a resident of Saudi Arabia. */
  region: textField(80).nullable().optional(),
  city: textField(80).nullable().optional(),
  trackId: idSchema,
  section,
});
export type CreateStudentDto = z.infer<typeof createStudentSchema>;

export const createCircleSchema = z.strictObject({
  name: textField(80),
  scopeId: idSchema,
  teacherId: idSchema.optional(),
  capacity: capacity.optional(),
  trackId: idSchema,
});
export type CreateAdminCircleDto = z.infer<typeof createCircleSchema>;

/** A null teacher clears her. A circle always has a track, so a track can only be replaced. */
export const updateCircleSchema = z
  .strictObject({
    name: textField(80).optional(),
    scopeId: idSchema.optional(),
    teacherId: idSchema.nullable().optional(),
    capacity: capacity.optional(),
    trackId: idSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateAdminCircleDto = z.infer<typeof updateCircleSchema>;

export const moveTeacherSchema = z.strictObject({ scopeId: idSchema });
export type MoveTeacherDto = z.infer<typeof moveTeacherSchema>;

/** Anything the administration can correct on a student's account. A new track restarts the plan on it. */
export const updateStudentSchema = z
  .strictObject({
    status: accountStatus.optional(),
    fullName: textField(120).optional(),
    phone: phoneField.optional(),
    country: textField(80).optional(),
    /** Null clears them, as for a student outside Saudi Arabia. */
    region: textField(80).nullable().optional(),
    city: textField(80).nullable().optional(),
    section: z.enum(['WOMEN', 'MEN']).optional(),
    ageBand: z.enum(AGE_BANDS).nullable().optional(),
    trackId: idSchema.optional(),
    /** Where the stabilization track begins. Null for the other tracks. */
    trackStart: z.enum(['KAHF', 'FATIHA']).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateStudentDto = z.infer<typeof updateStudentSchema>;

export const moveStudentSchema = z.strictObject({ circleId: idSchema });
export type MoveStudentDto = z.infer<typeof moveStudentSchema>;

export const listTransfersSchema = z.strictObject({
  ...pageFields,
  status: z.enum(['PENDING_ADMIN', 'PENDING_TEACHER', 'COMPLETED', 'REJECTED', 'CANCELLED']).default('PENDING_ADMIN'),
});
export type ListTransfersDto = z.infer<typeof listTransfersSchema>;

export const listAuditSchema = z.strictObject({ ...pageFields, actorId: idSchema.optional() });
export type ListAuditDto = z.infer<typeof listAuditSchema>;
