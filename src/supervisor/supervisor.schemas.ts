import { z } from 'zod';
import { idSchema, phoneField, textField } from '../common/staff-api.js';

const capacity = z.number().int().min(1).max(200);

export const createCircleSchema = z.strictObject({
  name: textField(80),
  teacherId: idSchema,
  trackId: idSchema,
  capacity: capacity.optional(),
});
export type CreateCircleDto = z.infer<typeof createCircleSchema>;

export const updateCircleSchema = z
  // A null teacher leaves the circle without one, which frees her to take another circle.
  .strictObject({ name: textField(80).optional(), teacherId: idSchema.nullable().optional(), capacity: capacity.optional() })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateCircleDto = z.infer<typeof updateCircleSchema>;

// Her email stays with the administration: it recovers her password, so changing it could take over the account.
export const updateTeacherSchema = z
  .strictObject({ fullName: textField(120).optional(), phone: phoneField.optional() })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateTeacherDto = z.infer<typeof updateTeacherSchema>;

export const assignStudentSchema = z.strictObject({ studentId: idSchema });
export type AssignStudentDto = z.infer<typeof assignStudentSchema>;

const orderedIds = (max: number) =>
  z
    .array(idSchema)
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'an id appears twice');

export const reorderCirclesSchema = z.strictObject({ circleIds: orderedIds(500) });
export type ReorderCirclesDto = z.infer<typeof reorderCirclesSchema>;

export const reorderStudentsSchema = z.strictObject({ studentIds: orderedIds(200) });
export type ReorderStudentsDto = z.infer<typeof reorderStudentsSchema>;

export const requestTransferSchema =z.strictObject({ studentId: idSchema, toCircleId: idSchema });
export type RequestTransferDto = z.infer<typeof requestTransferSchema>;

export const createAnnouncementSchema = z
  .strictObject({
    audience: z.enum(['SCOPE', 'CIRCLE']),
    circleId: idSchema.optional(),
    title: textField(160),
    body: textField(2000),
  })
  .refine((value) => (value.audience === 'CIRCLE') === (value.circleId !== undefined), {
    message: 'circleId goes with a CIRCLE announcement, and only then',
    path: ['circleId'],
  });
export type CreateAnnouncementDto = z.infer<typeof createAnnouncementSchema>;
