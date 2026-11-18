import { z } from 'zod';
import { idSchema, pageFields, textField } from '../common/staff-api.js';

const MAX_SCORE = 10;

const evaluationFields = {
  surah: z.number().int().min(1).max(114),
  fromAyah: z.number().int().min(1),
  toAyah: z.number().int().min(1),
  score: z.number().min(0).max(MAX_SCORE).nullable(),
  note: z.string().trim().max(1000).optional(),
  segmentStatus: z.enum(['NEEDS_REVIEW', 'MASTERED']).nullable(),
  attendance: z.enum(['PRESENT', 'LATE', 'ABSENT']),
};

type EvaluationShape = {
  fromAyah: number;
  toAyah: number;
  score: number | null;
  segmentStatus: string | null;
  attendance: string;
};

const checkEvaluation = (value: EvaluationShape, ctx: z.RefinementCtx) => {
  if (value.fromAyah > value.toAyah) {
    ctx.addIssue({ code: 'custom', path: ['toAyah'], message: 'toAyah must not come before fromAyah' });
  }
  // An absent student recited nothing, and anyone else must get a score.
  const absent = value.attendance === 'ABSENT';
  if (absent !== (value.score === null)) {
    ctx.addIssue({ code: 'custom', path: ['score'], message: 'a score goes with attendance, and only then' });
  }
  if (absent && value.segmentStatus !== null) {
    ctx.addIssue({ code: 'custom', path: ['segmentStatus'], message: 'an absent student has no segment status' });
  }
};

export const createRecitationSchema = z
  .strictObject({ studentId: idSchema, ...evaluationFields })
  .superRefine(checkEvaluation);
export type CreateRecitationDto = z.infer<typeof createRecitationSchema>;

export const evaluateSessionSchema = z.strictObject(evaluationFields).superRefine(checkEvaluation);
export type EvaluateSessionDto = z.infer<typeof evaluateSessionSchema>;

/** A correction to a recitation already saved. What was recited, and the attendance, stay as they were. */
export const updateRecitationSchema = z
  .strictObject({
    score: z.number().min(0).max(MAX_SCORE).optional(),
    note: z.string().trim().max(1000).optional(),
    segmentStatus: z.enum(['NEEDS_REVIEW', 'MASTERED']).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateRecitationDto = z.infer<typeof updateRecitationSchema>;

export const attendanceSchema = z.strictObject({ studentId: idSchema, attendance: z.enum(['PRESENT', 'LATE', 'ABSENT', 'EXCUSED']) });
export type AttendanceDto = z.infer<typeof attendanceSchema>;

export const attendanceSheetSchema = z.strictObject({
  entries: z
    .array(z.strictObject({ studentId: idSchema, attendance: attendanceSchema.shape.attendance }))
    .min(1)
    .max(200)
    .refine((entries) => new Set(entries.map(({ studentId }) => studentId)).size === entries.length, 'each student once'),
});
export type AttendanceSheetDto = z.infer<typeof attendanceSheetSchema>;

export const listRecitationsSchema = z.strictObject({ ...pageFields, studentId: idSchema.optional() });
export type ListRecitationsDto = z.infer<typeof listRecitationsSchema>;

export const listStudentsSchema = z.strictObject({
  ...pageFields,
  // Pickers read the whole list, and a circle holds up to 200 students.
  limit: z.coerce.number().int().min(1).max(200).default(20),
  search: z.string().trim().max(120).optional(),
});
export type ListStudentsDto = z.infer<typeof listStudentsSchema>;

export const createTaskSchema = z
  .strictObject({
    title: textField(200),
    description: z.string().trim().max(1000).optional(),
    /** Omit both for a teacher with one circle. A student makes it that student's task. */
    circleId: idSchema.optional(),
    studentId: idSchema.optional(),
    recurrence: z.enum(['DAILY', 'ONCE']),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    deadlineMinutes: z.number().int().min(0).max(1439).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.recurrence === 'ONCE') !== (value.dueAt !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['dueAt'], message: 'dueAt goes with a ONCE task, and only then' });
    }
    if (value.recurrence === 'ONCE' && value.deadlineMinutes !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['deadlineMinutes'], message: 'deadlineMinutes goes with a DAILY task' });
    }
    if (value.circleId && value.studentId) {
      ctx.addIssue({ code: 'custom', path: ['circleId'], message: 'send a circle or a student, not both' });
    }
  });
export type CreateTaskDto = z.infer<typeof createTaskSchema>;

export const listTasksSchema = z.strictObject({ status: z.enum(['ongoing', 'overdue', 'done']).optional() });
export type ListTasksDto = z.infer<typeof listTasksSchema>;

const sessionKind = z.enum(['RECITATION', 'CORRECTION', 'ISMA']);
/** One kind, or several separated by commas. */
export const listSessionsSchema = z.strictObject({
  ...pageFields,
  kind: z
    .string()
    .max(60)
    .transform((value) => value.split(','))
    .pipe(z.array(sessionKind).min(1))
    .optional(),
});
export type ListSessionsDto = z.infer<typeof listSessionsSchema>;

export const createSessionSchema = z
  .strictObject({
    kind: sessionKind,
    title: textField(120),
    /** An isma session's: whether the whole circle may stay in the room, or each student enters for her turn. */
    entryMode: z.enum(['OPEN', 'TURN']).optional(),
    scheduledAt: z.iso.datetime({ offset: true }),
    studentId: idSchema.optional(),
    circleId: idSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'RECITATION' && !value.studentId) {
      ctx.addIssue({ code: 'custom', path: ['studentId'], message: 'a recitation session is with one student' });
    }
    if (value.kind === 'ISMA' && value.studentId) {
      ctx.addIssue({ code: 'custom', path: ['studentId'], message: 'an isma session is for the whole circle' });
    }
    if (value.kind !== 'ISMA' && value.entryMode) {
      ctx.addIssue({ code: 'custom', path: ['entryMode'], message: 'only an isma session has an entry mode' });
    }
    if (value.studentId && value.circleId) {
      ctx.addIssue({ code: 'custom', path: ['circleId'], message: 'send a circle or a student, not both' });
    }
  });
export type CreateSessionDto = z.infer<typeof createSessionSchema>;

export const sessionNotesSchema = z.strictObject({ notes: textField(2000) });
export type SessionNotesDto = z.infer<typeof sessionNotesSchema>;

export const reportQuerySchema = z.strictObject({ period: z.enum(['week', 'month']).default('week') });
export type ReportQueryDto = z.infer<typeof reportQuerySchema>;

// ---------- حلقة الإسماع ----------

export const ismaOrderSchema = z.strictObject({ turnIds: z.array(idSchema).min(1).max(200) });
export type IsmaOrderDto = z.infer<typeof ismaOrderSchema>;

export const ismaMarkSchema = z.strictObject({ kind: z.enum(['MISTAKE', 'WARNING']) });
export type IsmaMarkDto = z.infer<typeof ismaMarkSchema>;

export const ismaMarkNoteSchema = z.strictObject({ note: z.string().trim().max(500) });
export type IsmaMarkNoteDto = z.infer<typeof ismaMarkNoteSchema>;

export const ismaAttendanceSchema = z.strictObject({ attendance: z.enum(['PRESENT', 'LATE', 'ABSENT', 'EXCUSED']) });
export type IsmaAttendanceDto = z.infer<typeof ismaAttendanceSchema>;

/** A reminder of where she stands in the queue, or the teacher's own words. To one student, or to all of them. */
export const ismaNotifySchema = z
  .strictObject({
    kind: z.enum(['TURN_REMINDER', 'CUSTOM']),
    studentId: idSchema.optional(),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'CUSTOM' && !value.body) ctx.addIssue({ code: 'custom', path: ['body'], message: 'a custom notice needs a body' });
  });
export type IsmaNotifyDto = z.infer<typeof ismaNotifySchema>;
