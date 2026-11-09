import { z } from 'zod';
import { idSchema, pageFields, textField } from '../common/staff-api.js';
import { admissionSettingsSchema, featureSettingsSchema, gateSettingsSchema, permissionSettingsSchema } from '../program/settings.service.js';

const weekDays = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length, 'days must not repeat');

const trackBase = {
  name: textField(120),
  audience: textField(200),
  duration: textField(60),
  active: z.boolean().optional(),
};

// A new step has no id yet. Each counted kind appears once, because a track has one target for each.
const wirdSteps = z
  .array(
    z.strictObject({
      id: z.number().int().min(0).max(2_147_483_647).optional(),
      kind: z.enum(['REVIEW', 'LISTEN', 'TASK', 'REPEAT']),
      title: textField(120),
      subtitle: z.string().trim().max(160).default(''),
    }),
  )
  .min(1)
  .max(15)
  .refine((steps) => steps.filter(({ kind }) => kind === 'REVIEW').length <= 1, 'one review step at most')
  .refine((steps) => steps.filter(({ kind }) => kind === 'REPEAT').length <= 1, 'one repeat step at most')
  .refine((steps) => {
    const ids = steps.flatMap(({ id }) => (id === undefined ? [] : [id]));
    return new Set(ids).size === ids.length;
  }, 'step ids must not repeat');
const repeatTarget = z.number().int().min(1).max(500);
const reviewTarget = z.number().int().min(1).max(100);
const encouragements = z.array(textField(160)).max(30);

export const createTrackSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('MEMORIZATION'),
    ...trackBase,
    dailyUnit: z.enum(['HALF_PAGE', 'PAGE', 'SURAH']),
    wirdDays: weekDays,
    consolidationDays: z.number().int().min(0).max(7),
    wirdSteps: wirdSteps.optional(),
    repeatTarget: repeatTarget.optional(),
    reviewTarget: reviewTarget.optional(),
    encouragements: encouragements.optional(),
  }),
  z.strictObject({
    kind: z.literal('CORRECTION'),
    ...trackBase,
    focus: textField(120),
    sessionsPerWeek: z.number().int().min(1).max(7),
    application: textField(120),
  }),
]);
export type CreateTrackDto = z.infer<typeof createTrackSchema>;

export const updateTrackSchema = z
  .strictObject({
    name: textField(120).optional(),
    audience: textField(200).optional(),
    duration: textField(60).optional(),
    active: z.boolean().optional(),
    dailyUnit: z.enum(['HALF_PAGE', 'PAGE', 'SURAH']).optional(),
    wirdDays: weekDays.optional(),
    consolidationDays: z.number().int().min(0).max(7).optional(),
    wirdSteps: wirdSteps.optional(),
    repeatTarget: repeatTarget.optional(),
    reviewTarget: reviewTarget.optional(),
    encouragements: encouragements.optional(),
    focus: textField(120).optional(),
    sessionsPerWeek: z.number().int().min(1).max(7).optional(),
    application: textField(120).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateTrackDto = z.infer<typeof updateTrackSchema>;

export const gateModeSchema = z.strictObject({ mode: z.enum(['ACTIVE', 'RELAXED', 'TEACHER', 'PAUSED']) });

export { admissionSettingsSchema, featureSettingsSchema, gateSettingsSchema, permissionSettingsSchema };

export const createExceptionSchema = z.strictObject({
  studentId: idSchema,
  type: z.enum(['SKIP_WRAP', 'SKIP_TAFSIR', 'RELAXED_GATE', 'POSTPONE_EXAM']),
  reason: textField(300),
  /** Omit for a permanent exception. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).superRefine((value, ctx) => {
  if (value.type === 'POSTPONE_EXAM' && !value.expiresAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'a postponed exam needs a date' });
  }
});
export type CreateExceptionDto = z.infer<typeof createExceptionSchema>;

const httpsLink = z
  .url()
  .max(500)
  .refine((value) => new URL(value).protocol === 'https:', 'the link must use https');

export const tadabburSchema = z.strictObject({
  lessonType: textField(40),
  sheikh: textField(120),
  schedule: textField(80),
  link: httpsLink.nullable(),
  journaling: z.boolean(),
  published: z.boolean(),
  /** Replaces the list. A task with an id keeps its students' completions. */
  tasks: z
    .array(z.strictObject({ id: idSchema.optional(), title: textField(160), note: z.string().trim().max(300) }))
    .max(20),
});
export type TadabburDto = z.infer<typeof tadabburSchema>;

export const surahParam = z.coerce.number().int().min(1).max(114);

export const uploadTranslationSchema = z.strictObject({ language: textField(40), source: textField(160) });
export type UploadTranslationDto = z.infer<typeof uploadTranslationSchema>;

export const previewQuerySchema = z.strictObject({
  surah: z.coerce.number().int().min(1).max(114).default(18),
  ayah: z.coerce.number().int().min(1).default(10),
});

export const languageParam = z.enum(['ar', 'en']);

export const infoPageSchema = z.strictObject({ title: textField(160), body: textField(20000) });
export type InfoPageDto = z.infer<typeof infoPageSchema>;
export const slugParam = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const pledgesSchema = z.strictObject({ items: z.array(textField(300)).length(3) });

export const badgeConditionSchema = z.strictObject({ condition: textField(200) });
export const createBadgeSchema = z.strictObject({
  label: textField(60),
  condition: textField(200),
  // Names the app's icon set knows.
  icon: z.enum(['flame-outline', 'star-outline', 'book-outline', 'repeat', 'trophy-outline', 'ribbon-outline', 'medal-outline']),
  /** MANUAL is awarded by the administrator. The others are awarded by the program when the event happens. */
  trigger: z.enum(['MANUAL', 'SURAH_PASSED', 'TRACK_COMPLETED']),
});
export type CreateBadgeDto = z.infer<typeof createBadgeSchema>;
export const awardBadgeSchema = z.strictObject({ badgeId: idSchema });
export const messageSchema = z.strictObject({ text: textField(160) });

const audience = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ALL') }),
  z.strictObject({ type: z.literal('TRACK'), trackId: idSchema }),
  z.strictObject({ type: z.literal('CIRCLE'), circleId: idSchema }),
]);

export const createBroadcastSchema = z
  .strictObject({
    kind: z.enum(['ANNOUNCEMENT', 'ALERT']),
    title: textField(160),
    body: textField(2000),
    audience,
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'ALERT' && (value.startsAt || value.endsAt)) {
      ctx.addIssue({ code: 'custom', path: ['startsAt'], message: 'an alert goes out at once and has no period' });
    }
    if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'the end must come after the start' });
    }
  });
export type CreateBroadcastDto = z.infer<typeof createBroadcastSchema>;

export const listBroadcastsSchema = z.strictObject({ ...pageFields, kind: z.enum(['ANNOUNCEMENT', 'ALERT']).default('ANNOUNCEMENT') });
export type ListBroadcastsDto = z.infer<typeof listBroadcastsSchema>;

export const reportDaysSchema = z.strictObject({ days: z.coerce.number().int().min(1).max(365).default(30) });
