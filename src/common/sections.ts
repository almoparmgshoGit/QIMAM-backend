import type { Prisma } from '../generated/prisma/client.js';
import type { RecitationMode, StudentSection } from '../generated/prisma/enums.js';
import { ApiError } from './api-error.js';

// The men's and the women's sections never meet in a circle: a teacher teaches her own section only.

type Db = Pick<Prisma.TransactionClient, 'circle' | 'user'>;

const ALTERNATIVE = /\{\{([^{}|]*)\|([^{}|]*)\}\}/g;

/**
 * Text written once for both sections: «{{for men|for women}}» picks the reader's own wording,
 * as certificates do. «أحسنت{{|ِ}}» reads «أحسنت» to a man and «أحسنتِ» to a woman.
 */
export const forSection = (text: string, section: StudentSection): string =>
  text.replace(ALTERNATIVE, (_, men: string, women: string) => (section === 'MEN' ? men : women));

export const hasAlternatives = (text: string): boolean => text.includes('{{') && /\{\{[^{}|]*\|[^{}|]*\}\}/.test(text);

/** For a teacher taking a circle: everyone in it must be of her section. */
export async function assertStudentsOfSection(db: Db, circleId: string, section: StudentSection): Promise<void> {
  const mixed = await db.circle.count({
    where: { id: circleId, memberships: { some: { leftAt: null, student: { section: { not: section } } } } },
  });
  if (mixed > 0) throw new ApiError(409, 'section_mismatch');
}

export async function assertTeacherFitsCircle(db: Db, circleId: string, teacherId: string): Promise<void> {
  const teacher = await db.user.findUnique({ where: { id: teacherId }, select: { section: true } });
  if (teacher) await assertStudentsOfSection(db, circleId, teacher.section);
}

/** For a student joining a circle: its teacher and students must be of her section. */
export async function assertStudentSectionFits(db: Db, circleId: string, studentId: string): Promise<void> {
  const student = await db.user.findUnique({ where: { id: studentId }, select: { section: true } });
  if (!student) return;
  const other = { not: student.section };
  const mixed = await db.circle.count({
    where: {
      id: circleId,
      OR: [{ teacher: { section: other } }, { memberships: { some: { leftAt: null, student: { section: other } } } }],
    },
  });
  if (mixed > 0) throw new ApiError(409, 'section_mismatch');
}

/** Online recitation with a teacher is for the women's section only, so a track that uses it is closed to men. */
export const trackFitsSection = (recitationMode: RecitationMode, section: StudentSection): boolean =>
  section === 'WOMEN' || recitationMode !== 'LIVE';

export function assertTrackFitsSection(recitationMode: RecitationMode, section: StudentSection): void {
  if (!trackFitsSection(recitationMode, section)) throw new ApiError(409, 'track_not_for_section');
}
