import { z } from 'zod';
import { idSchema, pageFields, textField } from '../common/staff-api.js';
import { admissionSettingsSchema, featureSettingsSchema, gateSettingsSchema, permissionSettingsSchema, stageExamSettingsSchema } from '../program/settings.service.js';

const weekDays = z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length, 'days must not repeat');

const trackBase = {
  name: textField(120),
  audience: textField(200),
  /** Up to 50 years. The words students read are made from it. */
  durationMonths: z.number().int().min(1).max(600),
  active: z.boolean().optional(),
};

// A new step has no id yet. Each counted kind appears once, because a track has one target for each.
const wirdSteps = z
  .array(
    z.strictObject({
      id: z.number().int().min(0).max(2_147_483_647).optional(),
      kind: z.enum(['REVIEW', 'LISTEN', 'TASK', 'REPEAT', 'SESSION']),
      title: textField(120),
      subtitle: z.string().trim().max(160).default(''),
      /** Each kind's own settings. A setting that doesn't belong to the kind is ignored. */
      options: z
        .strictObject({
          optional: z.boolean().optional(),
          showMushaf: z.boolean().optional(),
          portions: z.number().int().min(1).max(5).optional(),
          allowPeek: z.boolean().optional(),
          completion: z.enum(['ATTENDED', 'EVALUATED', 'MASTERED']).optional(),
          selfConfirm: z.boolean().optional(),
        })
        .optional(),
    }),
  )
  .min(1)
  .max(15)
  .refine((steps) => steps.filter(({ kind }) => kind === 'SESSION').length <= 1, 'one session step at most')
  .refine((steps) => steps.filter(({ kind }) => kind === 'REVIEW').length <= 1, 'one review step at most')
  .refine((steps) => steps.filter(({ kind }) => kind === 'REPEAT').length <= 1, 'one repeat step at most')
  .refine((steps) => steps.filter(({ kind }) => kind === 'LISTEN').length <= 1, 'one listening step at most')
  .refine((steps) => {
    const ids = steps.flatMap(({ id }) => (id === undefined ? [] : [id]));
    return new Set(ids).size === ids.length;
  }, 'step ids must not repeat');
const repeatTarget = z.number().int().min(1).max(500);
const reviewTarget = z.number().int().min(1).max(100);
const listenTarget = z.number().int().min(1).max(50);
const encouragements = z.array(textField(160)).max(30);

const juz = z.number().int().min(1).max(30);
const memorizationOrder = z.enum(['FORWARD', 'BACKWARD']);
const selectedSurahs = z
  .array(z.number().int().min(1).max(114))
  .max(114)
  .refine((surahs) => new Set(surahs).size === surahs.length, 'surahs must not repeat');
/** The surah a track begins at. Null begins at the order's own start. */
const startSurah = z.number().int().min(1).max(114);
/**
 * Both ends of a juz' range in order, or neither. A track covers a juz' range or chosen surahs, not both.
 * A start surah goes with the whole Quran, or is one of the chosen surahs; a juz' range begins where it begins.
 */
const scopeIsValid = (value: { juzFrom?: number | null; juzTo?: number | null; selectedSurahs?: number[]; startSurah?: number | null }) =>
  (value.juzFrom == null) === (value.juzTo == null) &&
  (value.juzFrom == null || value.juzTo! >= value.juzFrom) &&
  !(value.juzFrom != null && (value.selectedSurahs?.length ?? 0) > 0) &&
  (value.startSurah == null ||
    (value.juzFrom == null && (!value.selectedSurahs?.length || value.selectedSurahs.includes(value.startSurah))));
const SCOPE_ERROR = {
  message: 'a juz range needs both ends in order and goes without chosen surahs or a start surah; a start surah must be one of the chosen surahs',
  path: ['juzFrom'],
};

const dailyUnit = z.enum(['HALF_PAGE', 'PAGE', 'SURAH', 'AYAHS']);
/** Up to the longest surah, Al-Baqarah. */
const dailyAyahs = z.number().int().min(1).max(286);
/** A number of ayahs goes with AYAHS only. AYAHS suits any scope: the whole Quran, a juz' range or chosen surahs. */
export const dailyAmountIsValid = (value: { dailyUnit?: string | null; dailyAyahs?: number | null }) =>
  (value.dailyUnit === 'AYAHS') === (value.dailyAyahs != null);
const DAILY_AMOUNT_ERROR = { message: 'a number of ayahs a day goes with AYAHS only', path: ['dailyAyahs'] };
/** Optional sessions a day, such as morning and evening, that share the day's portion. Null keeps it whole. */
const dailySessions = z.number().int().min(2).max(4);
/** Online voice sessions, recordings sent from the app, or neither. It decides how the wird's session step is done. */
const recitationMode = z.enum(['LIVE', 'RECORDING', 'NONE']);

const reviewEndRule = z.enum(['DURATION', 'SCOPE', 'EITHER']);
const reviewFinalKinds = z
  .array(z.enum(['RECITATION', 'EXAM']))
  .min(1)
  .max(2)
  .refine((kinds) => new Set(kinds).size === kinds.length, 'kinds must not repeat');
const reviewPassScore = z.number().min(0).max(10).multipleOf(0.1);
const reviewFailAction = z.enum(['RETAKE', 'EXTEND', 'RESTART']);
const reviewExtendDays = z.number().int().min(1).max(365);
const reviewMoveMode = z.enum(['AUTO', 'EXAMINER']);

/** What a review track adds: when it ends, its final test, and what passing or failing it leads to. */
const reviewFields = {
  reviewEndRule,
  reviewFinalKinds,
  /** Null takes the stage exam's pass score. */
  reviewPassScore: reviewPassScore.nullable().default(null),
  reviewFailAction,
  reviewExtendDays: reviewExtendDays.nullable().default(null),
  reviewMoveMode,
  reviewNextTrackId: idSchema.nullable().default(null),
};

/** Extra days go with EXTEND only, and an automatic move needs the track to move to. */
export const reviewRulesAreValid = (value: { reviewFailAction?: string | null; reviewExtendDays?: number | null; reviewMoveMode?: string | null; reviewNextTrackId?: string | null }) =>
  (value.reviewFailAction === 'EXTEND') === (value.reviewExtendDays != null) && (value.reviewMoveMode !== 'AUTO' || value.reviewNextTrackId != null);
const REVIEW_RULES_ERROR = { message: 'extra days go with EXTEND only, and an automatic move needs its track', path: ['reviewExtendDays'] };

export const createTrackSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('MEMORIZATION'),
    ...trackBase,
    // Chosen surahs have no direction, so a track of them may leave it out.
    memorizationOrder: memorizationOrder.default('FORWARD'),
    juzFrom: juz.nullable().default(null),
    juzTo: juz.nullable().default(null),
    selectedSurahs: selectedSurahs.default([]),
    startSurah: startSurah.nullable().default(null),
    dailyUnit,
    dailyAyahs: dailyAyahs.nullable().default(null),
    dailySessions: dailySessions.nullable().default(null),
    wirdDays: weekDays,
    consolidationDays: z.number().int().min(0).max(7),
    wirdSteps: wirdSteps.optional(),
    recitationMode: recitationMode.default('LIVE'),
    repeatTarget: repeatTarget.optional(),
    reviewTarget: reviewTarget.optional(),
    listenTarget: listenTarget.optional(),
    encouragements: encouragements.optional(),
  })
    .refine(scopeIsValid, SCOPE_ERROR)
    .refine(dailyAmountIsValid, DAILY_AMOUNT_ERROR),
  // A review track has a memorization track's plan, and its own end.
  z.strictObject({
    kind: z.literal('REVIEW'),
    ...trackBase,
    memorizationOrder: memorizationOrder.default('FORWARD'),
    juzFrom: juz.nullable().default(null),
    juzTo: juz.nullable().default(null),
    selectedSurahs: selectedSurahs.default([]),
    startSurah: startSurah.nullable().default(null),
    dailyUnit,
    dailyAyahs: dailyAyahs.nullable().default(null),
    dailySessions: dailySessions.nullable().default(null),
    wirdDays: weekDays,
    consolidationDays: z.number().int().min(0).max(7),
    wirdSteps: wirdSteps.optional(),
    recitationMode: recitationMode.default('LIVE'),
    repeatTarget: repeatTarget.optional(),
    reviewTarget: reviewTarget.optional(),
    listenTarget: listenTarget.optional(),
    encouragements: encouragements.optional(),
    ...reviewFields,
  })
    .refine(scopeIsValid, SCOPE_ERROR)
    .refine(dailyAmountIsValid, DAILY_AMOUNT_ERROR)
    .refine(reviewRulesAreValid, REVIEW_RULES_ERROR),
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
    durationMonths: z.number().int().min(1).max(600).optional(),
    active: z.boolean().optional(),
    /** Checked with the saved track, since either may change alone. */
    dailyUnit: dailyUnit.optional(),
    dailyAyahs: dailyAyahs.nullable().optional(),
    dailySessions: dailySessions.nullable().optional(),
    /** The four go together, so they are checked as one. */
    memorizationOrder: memorizationOrder.optional(),
    juzFrom: juz.nullable().optional(),
    juzTo: juz.nullable().optional(),
    selectedSurahs: selectedSurahs.optional(),
    /** Goes with the four above. Left out with them, the track begins at the order's own start. */
    startSurah: startSurah.nullable().optional(),
    wirdDays: weekDays.optional(),
    consolidationDays: z.number().int().min(0).max(7).optional(),
    wirdSteps: wirdSteps.optional(),
    recitationMode: recitationMode.optional(),
    repeatTarget: repeatTarget.optional(),
    reviewTarget: reviewTarget.optional(),
    listenTarget: listenTarget.optional(),
    encouragements: encouragements.optional(),
    focus: textField(120).optional(),
    sessionsPerWeek: z.number().int().min(1).max(7).optional(),
    application: textField(120).optional(),
    /** Review tracks only. Checked with the saved track, since each may change alone. */
    reviewEndRule: reviewEndRule.optional(),
    reviewFinalKinds: reviewFinalKinds.optional(),
    reviewPassScore: reviewPassScore.nullable().optional(),
    reviewFailAction: reviewFailAction.optional(),
    reviewExtendDays: reviewExtendDays.nullable().optional(),
    reviewMoveMode: reviewMoveMode.optional(),
    reviewNextTrackId: idSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update')
  .refine(
    (value) => {
      const fields = [value.memorizationOrder, value.juzFrom, value.juzTo, value.selectedSurahs];
      return fields.every((field) => field === undefined)
        ? value.startSurah === undefined
        : fields.every((field) => field !== undefined) && scopeIsValid(value);
    },
    SCOPE_ERROR,
  );
export type UpdateTrackDto = z.infer<typeof updateTrackSchema>;

export const gateModeSchema = z.strictObject({ mode: z.enum(['ACTIVE', 'RELAXED', 'TEACHER', 'PAUSED']) });
export const stageExamModeSchema = z.strictObject({ mode: z.enum(['OFF', 'REQUIRED', 'BLOCKING']) });

export { admissionSettingsSchema, featureSettingsSchema, gateSettingsSchema, permissionSettingsSchema, stageExamSettingsSchema };

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

export const messageSchema = z.strictObject({ text: textField(160) });

export const createTeacherIncentiveSchema = z.strictObject({
  title: textField(160),
  body: textField(2000),
  /** Omit to send to every active teacher. */
  teacherId: idSchema.optional(),
  /** Omit to send at once. */
  sendAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateTeacherIncentiveDto = z.infer<typeof createTeacherIncentiveSchema>;

export const listTeacherIncentivesSchema = z.strictObject({ ...pageFields });
export type ListTeacherIncentivesDto = z.infer<typeof listTeacherIncentivesSchema>;

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
