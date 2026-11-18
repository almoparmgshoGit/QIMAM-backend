import { z } from 'zod';
import { idSchema, pageFields, textField } from '../common/staff-api.js';

/** Names from the app's icon set (Ionicons). The dashboard draws each one with a matching icon. */
export const BADGE_ICONS = [
  'trophy-outline',
  'star-outline',
  'flame-outline',
  'book-outline',
  'repeat',
  'ribbon-outline',
  'medal-outline',
  'heart-outline',
  'sparkles-outline',
  'diamond-outline',
  'rocket-outline',
  'school-outline',
  'checkmark-done-outline',
  'sunny-outline',
  'moon-outline',
  'leaf-outline',
  'shield-checkmark-outline',
  'people-outline',
] as const;

// One emoji, possibly with skin tone, variation selector or joiners, and nothing else.
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\u{FE0F}|\u{200D}|\p{Emoji_Modifier}|\u{20E3}|\p{Extended_Pictographic}|\p{Regional_Indicator})*$/u;

const visualSchema = z.discriminatedUnion('visual', [
  z.strictObject({ visual: z.literal('ICON'), icon: z.enum(BADGE_ICONS) }),
  z.strictObject({ visual: z.literal('EMOJI'), icon: z.string().trim().min(1).max(32).regex(EMOJI, 'one emoji') }),
  // The picture is uploaded on its own, after the badge exists.
  z.strictObject({ visual: z.literal('IMAGE') }),
]);

const triggerSchema = z.enum(['MANUAL', 'SURAH_PASSED', 'PAGES_MEMORIZED', 'WIRD_DAYS', 'TRACK_COMPLETED']);
const COUNTED = new Set(['SURAH_PASSED', 'PAGES_MEMORIZED', 'WIRD_DAYS']);

const badgeFields = z.strictObject({
  label: textField(60),
  /** Shown to students. Left empty, an automatic badge describes its own rule. */
  condition: z.string().trim().max(200).nullable().default(null),
  look: visualSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  audience: z.enum(['STUDENTS', 'STAFF', 'EVERYONE']),
  trigger: triggerSchema,
  threshold: z.number().int().min(1).max(10_000).nullable().default(null),
  supervisorCanAward: z.boolean(),
  active: z.boolean().default(true),
});

/** An automatic badge counts a student's work, so it is for students, and a counted rule needs its count. */
const ruleIsValid = (value: { trigger?: string; threshold?: number | null; audience?: string }, ctx: z.RefinementCtx) => {
  if (value.trigger === undefined) return;
  if (value.trigger !== 'MANUAL' && value.audience !== 'STUDENTS') {
    ctx.addIssue({ code: 'custom', path: ['audience'], message: 'an automatic badge is for students' });
  }
  if (COUNTED.has(value.trigger) !== (value.threshold != null)) {
    ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'a counted rule needs a count, and only it' });
  }
};

export const createBadgeSchema = badgeFields.superRefine(ruleIsValid);
export type CreateBadgeDto = z.infer<typeof createBadgeSchema>;

/** The rule's three fields go together, so they are sent together. */
export const updateBadgeSchema = badgeFields
  .partial()
  .extend({ condition: z.string().trim().max(200).nullable().optional(), threshold: z.number().int().min(1).max(10_000).nullable().optional() })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update')
  .refine(
    (value) => {
      const rule = [value.trigger, value.threshold, value.audience];
      return rule.every((field) => field === undefined) || rule.every((field) => field !== undefined);
    },
    { message: 'trigger, threshold and audience go together', path: ['trigger'] },
  )
  .superRefine(ruleIsValid);
export type UpdateBadgeDto = z.infer<typeof updateBadgeSchema>;

export const awardSchema = z.strictObject({
  badgeId: idSchema,
  userId: idSchema,
  note: z.string().trim().max(200).optional(),
});
export type AwardDto = z.infer<typeof awardSchema>;

export const recipientsQuerySchema = z.strictObject({
  kind: z.enum(['STUDENT', 'STAFF']),
  q: z.string().trim().max(60).default(''),
});
export type RecipientsQuery = z.infer<typeof recipientsQuerySchema>;

/** The badges to show on one's profile, in order. Three at most; none unpins them all. */
export const pinsSchema = z.strictObject({
  badgeIds: z
    .array(idSchema)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length, 'badges must not repeat'),
});
export type PinsDto = z.infer<typeof pinsSchema>;

/** Comma-separated user ids, such as the rows of a list on screen. */
export const showcaseQuerySchema = z.strictObject({
  ids: z
    .string()
    .max(100 * 33)
    .transform((value) => [...new Set(value.split(',').filter(Boolean))])
    .pipe(z.array(idSchema).max(100)),
});
export type ShowcaseQuery = z.infer<typeof showcaseQuerySchema>;

export const awardsQuerySchema = z.strictObject({ ...pageFields });
export type AwardsQuery = z.infer<typeof awardsQuerySchema>;
