/**
 * What a rank can grant an employee. Each one opens a section of the admin dashboard, to read and to change.
 * An administrator has them all. Ranks store these keys, so a key is renamed only with a migration.
 */
export const PERMISSIONS = {
  'reports.view': { label: 'النظرة العامة والتقارير الإجمالية', group: 'عام' },
  'tracks.manage': { label: 'المسارات والخطط', group: 'المنهج والمحتوى' },
  'content.manage': { label: 'محتوى المصحف والتدبر والمهمات', group: 'المنهج والمحتوى' },
  'gates.manage': { label: 'شروط البوابة والاستثناءات', group: 'المنهج والمحتوى' },
  'accounts.manage': { label: 'الحلقات وحسابات المعلمين والمشرفين', group: 'المستخدمون' },
  'students.manage': { label: 'الطلاب', group: 'المستخدمون' },
  'admissions.manage': { label: 'اختبار القبول', group: 'المستخدمون' },
  'stage-exams.manage': { label: 'الاختبار المرحلي', group: 'المستخدمون' },
  'badges.manage': { label: 'الشارات', group: 'المستخدمون' },
  'certificates.manage': { label: 'الشهادات', group: 'المستخدمون' },
  'motivation.manage': { label: 'التحفيز وتكريم الحلقات', group: 'المستخدمون' },
  'announcements.manage': { label: 'الإعلانات والتنبيهات', group: 'النظام' },
  'support.manage': { label: 'الدعم الفني ومحادثاته', group: 'النظام' },
  'settings.manage': { label: 'الإعدادات', group: 'النظام' },
  'audit.view': { label: 'سجل التعديلات', group: 'النظام' },
} as const satisfies Record<string, { label: string; group: string }>;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];

/** For lookups every admin page needs, such as the list of tracks or scopes: any employee may read them. */
export const ANY_EMPLOYEE = '*';

export const permissionCatalog = () =>
  PERMISSION_KEYS.map((key) => ({ key, label: PERMISSIONS[key].label, group: PERMISSIONS[key].group }));
