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
});

const SCHEMAS = {
  gate: gateSettingsSchema,
  features: featureSettingsSchema,
  permissions: permissionSettingsSchema,
  pledges: pledgeSettingsSchema,
  admission: admissionSettingsSchema,
} as const;

type Schemas = typeof SCHEMAS;
export type SettingKey = keyof Schemas;
export type SettingValue<K extends SettingKey> = z.infer<Schemas[K]>;

const DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  gate: { tafsir: true, wrap: true, wrapCount: 5, exam: true, passScore: 7, examDelayDays: 14 },
  features: { englishEnabled: true, smartRecitation: true, offlineRecitation: true, encouragementEnabled: true },
  permissions: { openRecord: true, editTemplates: true },
  admission: { required: true },
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
