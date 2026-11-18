import type {
  AdmissionStatus,
  Language,
  NotificationType,
  StabilizationStart,
  StudentSection,
  TrackId,
} from '../generated/prisma/enums.js';

// The API speaks the same values as the app's types. The database uses its own enums.

const TRACK_TO_API = { ADVANCED: 'advanced', STEADY: 'steady', STABILIZATION: 'stabilization' } as const;
const START_TO_API = { KAHF: 'kahf', FATIHA: 'fatiha' } as const;
const LANGUAGE_TO_API = { AR: 'ar', EN: 'en' } as const;
const SECTION_TO_API = { WOMEN: 'women', MEN: 'men' } as const;
const NOTIFICATION_TO_API = {
  DAILY_WIRD: 'dailyWird',
  WEEKLY_REVIEW: 'weeklyReview',
  NEW_TASK: 'newTask',
  EVALUATION: 'evaluation',
  BADGES: 'badges',
  GENERAL: 'general',
  ENCOURAGEMENT: 'encouragement',
} as const;

const invert = <K extends string, V extends string>(map: Record<K, V>) =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [value, key])) as Record<V, K>;

const TRACK_FROM_API = invert(TRACK_TO_API);
const START_FROM_API = invert(START_TO_API);
const LANGUAGE_FROM_API = invert(LANGUAGE_TO_API);
const SECTION_FROM_API = invert(SECTION_TO_API);
const NOTIFICATION_FROM_API = invert(NOTIFICATION_TO_API);

export type ApiNotificationType = (typeof NOTIFICATION_TO_API)[NotificationType];

/** Only the original tracks have an enum value. A track the administrator added is known by its template alone. */
export const toTrackId = (code: string): TrackId | null =>
  Object.hasOwn(TRACK_FROM_API, code) ? TRACK_FROM_API[code as keyof typeof TRACK_FROM_API] : null;
export const toStabilizationStart = (value: keyof typeof START_FROM_API): StabilizationStart => START_FROM_API[value];
export const toLanguage = (value: keyof typeof LANGUAGE_FROM_API): Language => LANGUAGE_FROM_API[value];
export const toSection = (value: keyof typeof SECTION_FROM_API): StudentSection => SECTION_FROM_API[value];
export const toNotificationType = (value: ApiNotificationType): NotificationType => NOTIFICATION_FROM_API[value];

export interface ProfileRecord {
  id: string;
  fullName: string;
  phone: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  ageBand: string | null;
  section: StudentSection;
  trackTemplate: { code: string } | null;
  trackStart: StabilizationStart | null;
  language: Language;
  notificationPrefs: { type: NotificationType; enabled: boolean }[];
  memberships: { id: string }[];
  admissionStatus: AdmissionStatus;
  admissionNote: string | null;
  timeZone: string | null;
  reminderMinutes: number;
}

/** The explicit list of what a student may see of their own record. New columns stay private by default. */
export function toProfile(record: ProfileRecord) {
  return {
    id: record.id,
    name: record.fullName,
    phone: record.phone,
    country: record.country,
    region: record.region,
    city: record.city,
    ageBand: record.ageBand,
    section: SECTION_TO_API[record.section],
    trackId: record.trackTemplate?.code ?? null,
    trackStart: record.trackStart && START_TO_API[record.trackStart],
    hasCircle: record.memberships.length > 0,
    admission: { status: record.admissionStatus.toLowerCase(), note: record.admissionNote },
    preferences: {
      language: LANGUAGE_TO_API[record.language],
      timeZone: record.timeZone,
      reminderMinutes: record.reminderMinutes,
      notifications: Object.fromEntries(
        record.notificationPrefs.map((pref) => [NOTIFICATION_TO_API[pref.type], pref.enabled]),
      ),
    },
  };
}
