import { z } from 'zod';
import { idSchema, textField } from '../common/staff-api.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const between = (min: number, max: number) =>
  z.number().finite().min(min).max(max);

// Points on the page, 72 to the inch. An element may hang off the edge, but not far.
const box = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  x: between(-3000, 3000),
  y: between(-3000, 3000),
  w: between(1, 3000),
  h: between(1, 3000),
};

/**
 * What a design is made of. Text may hold variables: {{name}}, or {{for men|for women}} to follow the student's section.
 * The dashboard draws the same shapes on its design board, and the app draws them on the certificate.
 */
export const certificateElementSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...box,
    type: z.literal('text'),
    text: z.string().max(1000),
    size: between(4, 300),
    bold: z.boolean(),
    color,
    align: z.enum(['right', 'center', 'left']),
  }),
  z.strictObject({
    ...box,
    type: z.literal('rect'),
    stroke: color.nullable(),
    strokeWidth: between(0, 100),
    fill: color.nullable(),
    radius: between(0, 1500),
  }),
  z.strictObject({ ...box, type: z.literal('logo') }),
  /** A signature, stamp or header from the attachments library. */
  z.strictObject({ ...box, type: z.literal('image'), assetId: idSchema }),
]);
export type CertificateElement = z.infer<typeof certificateElementSchema>;

export const certificateElementsSchema = z
  .array(certificateElementSchema)
  .max(80)
  .refine(
    (elements) =>
      new Set(elements.map(({ id }) => id)).size === elements.length,
    'element ids must not repeat',
  );

const pageSide = z.number().int().min(72).max(3000);

const templateFields = {
  name: textField(120),
  trigger: z.enum([
    'MANUAL',
    'TRACK_COMPLETED',
    'CIRCLE_HONOR',
    'CIRCLE_HONOR_TEACHER',
  ]),
  /** For TRACK_COMPLETED only. Null means every track. */
  trackId: idSchema.nullable(),
  active: z.boolean(),
  width: pageSide,
  height: pageSide,
  elements: certificateElementsSchema,
};

export const createTemplateSchema = z.strictObject({
  ...templateFields,
  trackId: templateFields.trackId.default(null),
  active: templateFields.active.default(true),
  elements: templateFields.elements.default([]),
});
export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.strictObject(templateFields).partial();
export type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;

export const issueSchema = z.strictObject({
  studentIds: z.array(idSchema).min(1).max(200),
  note: z.string().trim().max(200).optional(),
});
export type IssueDto = z.infer<typeof issueSchema>;

/**
 * The certificates given with a circle honoring. Left out, the only active design of that kind is given, and
 * choosing is required when there are several. Null gives none of that kind.
 */
export const honorSchema = z.strictObject({
  studentTemplateId: idSchema.nullable().optional(),
  teacherTemplateId: idSchema.nullable().optional(),
  note: z.string().trim().max(200).optional(),
});
export type HonorDto = z.infer<typeof honorSchema>;

export const ASSET_KINDS = ['SIGNATURE', 'STAMP', 'HEADER'] as const;

/** The fields sent with an attachment's picture. */
export const createAssetSchema = z.strictObject({
  name: textField(80),
  kind: z.enum(ASSET_KINDS).default('SIGNATURE'),
});
export type CreateAssetDto = z.infer<typeof createAssetSchema>;
