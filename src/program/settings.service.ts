import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const gateSettingsSchema = z.strictObject({
  tafsir: z.boolean(),
  wrap: z.boolean(),
  wrapCount: z.number().int().min(1).max(50),
  exam: z.boolean(),
  passScore: z.number().min(0).max(10),
  examDelayDays: z.number().int().min(0).max(60),
});

export const featureSettingsSchema = z.strictObject({
  englishEnabled: z.boolean(),
  smartRecitation: z.boolean(),
  offlineRecitation: z.boolean(),
  encouragementEnabled: z.boolean(),
});

export const permissionSettingsSchema = z.strictObject({
  /** Whether a new teacher sees evaluations from before a transfer. */
  openRecord: z.boolean(),
  /** Whether supervisors may choose which track a circle presents. */
  editTemplates: z.boolean(),
});

export const pledgeSettingsSchema = z.strictObject({
  version: z.number().int().min(1),
  items: z.array(z.string().trim().min(1).max(300)).length(3),
});

export const admissionSettingsSchema = z.strictObject({
  /** Whether a new student waits for the recitation test before starting. */
  required: z.boolean(),
  /**
   * Who sets the test's time. SUPERVISOR: when assigning the teacher. STUDENT: she books one of the
   * teacher's times. BOTH: the supervisor may set it, and if she leaves it open, the student books.
   * A value saved before this existed reads as SUPERVISOR.
   */
  scheduling: z.enum(['SUPERVISOR', 'STUDENT', 'BOTH']).default('SUPERVISOR'),
});

const deduction = z.number().min(0).max(10);

export const stageExamSettingsSchema = z.strictObject({
  /** Where the sevenths begin: at the surahs of «فمي بشوق», or every 86 pages or so. */
  division: z.enum(['SURAHS', 'PAGES']),
  /**
   * Who sets the exam's time. TEACHER: the examiner. SUPERVISOR: the scope's supervisor. STUDENT: she books one of
   * the examiner's offered times. The supervisor may set or move it in every case.
   */
  scheduling: z.enum(['TEACHER', 'SUPERVISOR', 'STUDENT']),
  /** What each mistake takes off a recited surah's 10. A value saved before these existed reads the defaults. */
  deductions: z
    .strictObject({
      HIFZ: deduction,
      PROMPT: deduction,
      HESITATION: deduction,
      TAJWEED: deduction,
    })
    .default({ HIFZ: 1, PROMPT: 0.5, HESITATION: 0.25, TAJWEED: 0.25 }),
  /** The fewest surahs the examiner hears before the result can be recorded. */
  minSurahs: z.number().int().min(1).max(20).default(3),
  /** Out of 10. */
  passScore: z.number().min(0).max(10).default(7),
});

const SCHEMAS = {
  gate: gateSettingsSchema,
  features: featureSettingsSchema,
  permissions: permissionSettingsSchema,
  pledges: pledgeSettingsSchema,
  admission: admissionSettingsSchema,
  stageExam: stageExamSettingsSchema,
} as const;

type Schemas = typeof SCHEMAS;
export type SettingKey = keyof Schemas;
export type SettingValue<K extends SettingKey> = z.infer<Schemas[K]>;

const DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  gate: { tafsir: true, wrap: true, wrapCount: 5, exam: true, passScore: 7, examDelayDays: 14 },
  features: { englishEnabled: true, smartRecitation: true, offlineRecitation: true, encouragementEnabled: true },
  permissions: { openRecord: true, editTemplates: true },
  admission: { required: true, scheduling: 'SUPERVISOR' },
  stageExam: {
    division: 'SURAHS',
    scheduling: 'TEACHER',
    deductions: { HIFZ: 1, PROMPT: 0.5, HESITATION: 0.25, TAJWEED: 0.25 },
    minSurahs: 3,
    passScore: 7,
  },
  pledges: {
    version: 1,
    // In the order of the consent types: terms, plan pledge, seriousness pledge.
    items: [
      'أوافق على سياسة الخصوصية وشروط الاستخدام',
      'أتعهد لله أن أطبق الخطة كما هي بجميع تفاصيلها',
      'أتعهد بالجدية التامة في الدورة',
    ],
  },
};

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A stored value that no longer fits its shape falls back to the default, rather than breaking every request. */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    const parsed = SCHEMAS[key].safeParse(row?.value);
    return parsed.success ? (parsed.data as SettingValue<K>) : DEFAULTS[key];
  }

  async set<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void> {
    const json = value as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
  }
}
