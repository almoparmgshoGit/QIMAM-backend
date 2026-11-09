import { z } from 'zod';
import { idSchema, pageFields, phoneField, textField } from '../common/staff-api.js';

const accountStatus = z.enum(['ACTIVE', 'SUSPENDED']);
const staffRole = z.enum(['TEACHER', 'SUPERVISOR', 'ADMIN']);
const capacity = z.number().int().min(1).max(200);

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
    scopeId: idSchema.optional(),
    /** A free circle in the scope for a new teacher to take. */
    circleId: idSchema.optional(),
  })
  .refine((value) => (value.role === 'ADMIN') === (value.scopeId === undefined), {
    message: 'teachers and supervisors need a scope, and administrators have none',
    path: ['scopeId'],
  })
  .refine((value) => Boolean(value.email ?? value.phone), { message: 'an email or a phone number is required', path: ['email'] })
  .refine((value) => !value.circleId || value.role === 'TEACHER', { message: 'only a teacher takes a circle', path: ['circleId'] });
export type CreateStaffDto = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z
  .strictObject({
    fullName: textField(120).optional(),
    email: emailField.optional(),
    phone: phoneField.optional(),
    scopeId: idSchema.optional(),
    status: accountStatus.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateStaffDto = z.infer<typeof updateStaffSchema>;

export const listStaffSchema = z.strictObject({ ...pageFields, role: staffRole.optional(), scopeId: idSchema.optional() });
export type ListStaffDto = z.infer<typeof listStaffSchema>;

export const scopeSchema = z.strictObject({ name: textField(80) });
export type ScopeDto = z.infer<typeof scopeSchema>;

export const listStudentsSchema = z.strictObject({
  ...pageFields,
  search: z.string().trim().max(120).optional(),
  country: z.string().trim().max(80).optional(),
  trackId: idSchema.optional(),
  section: z.enum(['WOMEN', 'MEN']).optional(),
  status: z.enum(['active', 'awaitingAssignment', 'suspended']).optional(),
});
export type ListStudentsDto = z.infer<typeof listStudentsSchema>;

export const createStudentSchema = z.strictObject({
  fullName: textField(120),
  phone: phoneField,
  country: textField(80),
  trackId: idSchema,
  section: z.enum(['WOMEN', 'MEN']),
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

export const updateStudentSchema = z.strictObject({ status: accountStatus });
export type UpdateStudentDto = z.infer<typeof updateStudentSchema>;

export const listTransfersSchema = z.strictObject({
  ...pageFields,
  status: z.enum(['PENDING_ADMIN', 'PENDING_TEACHER', 'COMPLETED', 'REJECTED', 'CANCELLED']).default('PENDING_ADMIN'),
});
export type ListTransfersDto = z.infer<typeof listTransfersSchema>;

export const listAuditSchema = z.strictObject({ ...pageFields, actorId: idSchema.optional() });
export type ListAuditDto = z.infer<typeof listAuditSchema>;
