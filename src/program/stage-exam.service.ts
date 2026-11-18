import { Injectable } from '@nestjs/common';
import { isAdministration, type StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { SURAH_PAGES } from '../common/mushaf.js';
import { seventhOf, seventhsFinished, surahsOfSeventh } from '../common/sevenths.js';
import { findSurah } from '../common/surahs.js';
import { isUniqueViolation } from '../common/staff-api.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ReviewFinalKind, StageExamMarkKind, StageExamMode } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VoiceService } from '../voice/voice.service.js';
import { NotificationsService } from './notifications.service.js';
import { examLabel, FINAL_LABELS } from './review-rules.js';
import { SettingsService } from './settings.service.js';
import { countMarks, examScore, itemScore, MARK_LABELS, type ScoringRules } from './stage-exam-scoring.js';

export interface ExamItemInput {
  surah: number;
  fromAyah: number;
  toAyah: number;
}

export interface ArrangeStageExam {
  examinerId: string;
  /** ISO time. Null leaves it open, for whoever the settings let set it. */
  scheduledAt: string | null;
}

const OPEN = ['WAITING', 'SCHEDULED', 'IN_PROGRESS'] as const;
const FALLBACK_TIME_ZONE = 'Asia/Riyadh';
// Allows for a slow request when picking a time that starts now.
const SCHEDULE_GRACE_MS = 5 * 60 * 1000;

const notFound = () => new ApiError(404, 'not_found');

/** What the test is called in a sentence: «الاختبار المرحلي», or the final test's own name. */
const examNoun = (finalKind: ReviewFinalKind | null) => (finalKind ? FINAL_LABELS[finalKind] : 'الاختبار المرحلي');

/** The surahs of a plan's scope, in the mushaf's order: those with a page inside its page range, if it has one. */
export function scopeSurahs(plan: { surahOrder: number[]; pageRange: number[] }): number[] {
  const [first = 1, last = Infinity] = plan.pageRange;
  return [...new Set(plan.surahOrder)]
    .filter((surah) => SURAH_PAGES[surah]?.some(([page]) => page >= first && page <= last))
    .sort((a, b) => a - b);
}

/** «الأحد 16 نوفمبر، 7:30 م» on the reader's own clock. */
function formatTime(at: Date, timeZone: string | null): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('ar', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(at);
  try {
    return format(timeZone ?? FALLBACK_TIME_ZONE);
  } catch {
    return format(FALLBACK_TIME_ZONE);
  }
}

const SESSION_SELECT = {
  id: true,
  stage: true,
  finalKind: true,
  status: true,
  scheduledAt: true,
  startedAt: true,
  endedAt: true,
  retake: true,
  note: true,
  createdAt: true,
  examiner: { select: { id: true, fullName: true } },
  exam: { select: { score: true, passed: true } },
} satisfies Prisma.StageExamSessionSelect;

type SessionRow = Prisma.StageExamSessionGetPayload<{ select: typeof SESSION_SELECT }>;

const toSession = (row: SessionRow) => ({
  id: row.id,
  stage: row.stage,
  finalKind: row.finalKind,
  label: examLabel(row.stage, row.finalKind),
  status: row.status,
  scheduledAt: row.scheduledAt,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  retake: row.retake,
  note: row.note,
  createdAt: row.createdAt,
  examiner: row.examiner ? { id: row.examiner.id, name: row.examiner.fullName } : null,
  result: row.exam ? { score: Number(row.exam.score), passed: row.exam.passed } : null,
});

const ITEMS_SELECT = {
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    surah: true,
    fromAyah: true,
    toAyah: true,
    score: true,
    marks: { orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, note: true, createdAt: true } },
  },
} satisfies Prisma.StageExamSession$itemsArgs;

type ItemRow = Prisma.StageExamItemGetPayload<{ select: (typeof ITEMS_SELECT)['select'] }>;

/** The rules a result was computed with, or today's for an exam still being scored. */
const rulesOf = (stored: unknown, current: ScoringRules): ScoringRules => (stored && typeof stored === 'object' ? (stored as ScoringRules) : current);

/** Each surah with its mistakes and score: the stored one once the result is recorded, the running one until then. */
function describeItems(items: ItemRow[], rules: ScoringRules) {
  return items.map((item) => {
    const counts = countMarks(item.marks);
    return {
      id: item.id,
      surah: item.surah,
      surahName: findSurah(item.surah)?.name ?? String(item.surah),
      fromAyah: item.fromAyah,
      toAyah: item.toAyah,
      counts,
      score: item.score === null ? itemScore(counts, rules.deductions) : Number(item.score),
      marks: item.marks.map((mark) => ({ ...mark, label: MARK_LABELS[mark.kind] })),
    };
  });
}

/**
 * The live test of each seventh of the Quran. The program opens one when a student finishes a seventh, and tells
 * the examiner (the circle's teacher by default) and the scope's supervisors. The time is set by whoever the
 * settings name, the examiner tests the student alone in a voice room, and records the result. A failed try opens
 * a retake. A track may hold back new memorization until the exam is passed.
 */
@Injectable()
export class StageExamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly voice: VoiceService,
    private readonly audit: AuditService,
  ) {}

  // ---------- Opening, from the plan ----------

  /** After a student moves from `before` units done to `after`: opens an exam for each seventh she just finished. */
  async onProgress(studentId: string, units: { surah: number; page: number }[], before: number, after: number, mode: StageExamMode): Promise<void> {
    if (mode === 'OFF' || after <= before) return;
    const { division } = await this.settings.get('stageExam');
    for (const stage of seventhsFinished(units, before, after, division)) await this.open(studentId, stage, false, null);
  }

  /** Whether new memorization waits: the track asks it to, and an exam is still open. */
  async holdsBack(studentId: string, mode: StageExamMode): Promise<boolean> {
    if (mode !== 'BLOCKING') return false;
    // A review track's final test isn't one of the sevenths, so it holds nothing back.
    return (await this.prisma.stageExamSession.count({ where: { studentId, finalKind: null, status: { in: [...OPEN] } } })) > 0;
  }

  /**
   * Opens a review track's final test, as stage 0. A recitation goes to the circle's teacher. An exam waits for the
   * supervisor to give it to an examiner. False when one is already open.
   */
  async openFinal(studentId: string, kind: ReviewFinalKind, retake: boolean): Promise<boolean> {
    return this.open(studentId, 0, retake, null, kind);
  }

  /** A seventh already passed isn't tested again, unless this is a retake. One open exam per seventh at most. */
  private async open(studentId: string, stage: number, retake: boolean, examinerId: string | null, finalKind: ReviewFinalKind | null = null): Promise<boolean> {
    if (!finalKind && !retake && (await this.prisma.stageExam.count({ where: { studentId, stage, passed: true } })) > 0) return false;
    if ((await this.prisma.stageExamSession.count({ where: { studentId, stage, status: { in: [...OPEN] } } })) > 0) return false;

    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null },
      select: { circle: { select: { id: true, teacherId: true, scopeId: true } } },
    });
    const circle = membership?.circle ?? null;
    // A final exam is given by whoever the supervisor picks. Everything else goes to the circle's teacher by default.
    const examiner = examinerId ?? (finalKind === 'EXAM' ? null : (circle?.teacherId ?? null));
    let id: string;
    try {
      ({ id } = await this.prisma.stageExamSession.create({
        data: { studentId, stage, finalKind, retake, circleId: circle?.id ?? null, examinerId: examiner },
        select: { id: true },
      }));
    } catch (error) {
      // Opened at the same moment by another request.
      if (isUniqueViolation(error)) return false;
      throw error;
    }

    const [{ scheduling }, student] = await Promise.all([
      this.settings.get('stageExam'),
      this.prisma.user.findUniqueOrThrow({ where: { id: studentId }, select: { fullName: true } }),
    ]);
    const label = examLabel(stage, finalKind);
    await this.notifications.send([studentId], {
      type: 'EVALUATION',
      title: finalKind ? (retake ? `إعادة ${label}` : label) : retake ? `إعادة الاختبار المرحلي · ${label}` : `اختبار مرحلي · ${label}`,
      body:
        (retake || finalKind ? '' : `{{أتممت|أتممتِ}} ${label}، بارك الله فيك. `) +
        (scheduling === 'STUDENT' ? '{{اختر|اختاري}} موعد اختبارك المباشر من التطبيق.' : 'سيُحدَّد موعد اختبارك المباشر قريبًا.'),
      dedupeKey: `stage-exam-open:${id}`,
    });
    if (examiner) {
      await this.notifications.send([examiner], {
        type: 'GENERAL',
        title: finalKind ? `${label} بانتظار موعد` : retake ? 'إعادة اختبار مرحلي' : 'اختبار مرحلي بانتظار موعد',
        body: `${student.fullName} · ${label}${scheduling === 'TEACHER' ? '. {{حدد|حددي}} موعده من «الاختبارات المرحلية».' : ''}`,
        dedupeKey: `stage-exam-open:${id}`,
      });
    }
    if (circle) {
      await this.notifications.notifySupervisorsOf(circle.scopeId, {
        type: 'GENERAL',
        title: finalKind ? `طلب ${label}` : retake ? 'إعادة اختبار مرحلي' : 'اختبار مرحلي جديد',
        body: `${student.fullName} · ${label}${examiner ? '' : ' · بلا {{معلم|معلمة}} {{يختبره|يختبرها}}'}`,
        dedupeKey: `stage-exam-open:${id}`,
      });
    }
    return true;
  }

  // ---------- Supervisor and administration ----------

  /** A supervisor sees her scope's exams. The administration sees all. */
  private inReach(staff: StaffActor): Prisma.StageExamSessionWhereInput {
    return isAdministration(staff) ? {} : { circle: { scopeId: staff.scopeId ?? '' } };
  }

  /** Open exams, those waiting for a time first. Or the finished and cancelled ones, newest first. */
  async list(staff: StaffActor, state: 'OPEN' | 'CLOSED') {
    const [{ scheduling, division }, rows] = await Promise.all([
      this.settings.get('stageExam'),
      this.prisma.stageExamSession.findMany({
        where: { ...this.inReach(staff), status: state === 'OPEN' ? { in: [...OPEN] } : { in: ['COMPLETED', 'CANCELLED'] } },
        orderBy: state === 'OPEN' ? [{ scheduledAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }] : [{ updatedAt: 'desc' }],
        take: 200,
        select: {
          ...SESSION_SELECT,
          circle: { select: { id: true, name: true } },
          student: { select: { id: true, fullName: true, phone: true, section: true } },
        },
      }),
    ]);
    return {
      scheduling,
      division,
      items: rows.map(({ circle, student, ...row }) => ({
        ...toSession(row),
        circle: circle ? { id: circle.id, name: circle.name } : null,
        student: { id: student.id, name: student.fullName, phone: student.phone, section: student.section },
      })),
    };
  }

  /** Teachers who may examine: the supervisor's own scope's. The administration sees every active teacher. */
  async examiners(staff: StaffActor) {
    const rows = await this.prisma.user.findMany({
      where: { role: 'TEACHER', status: 'ACTIVE', ...(isAdministration(staff) ? {} : { scopeId: staff.scopeId ?? '' }) },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, section: true, scope: { select: { name: true } } },
    });
    return rows.map((row) => ({ id: row.id, name: row.fullName, section: row.section, scope: row.scope?.name ?? null }));
  }

  /** Picks the examiner, the circle's teacher or another, and sets or moves the time. An exam in progress can't move. */
  async arrange(staff: StaffActor, sessionId: string, { examinerId, scheduledAt }: ArrangeStageExam) {
    const at = scheduledAt === null ? null : new Date(scheduledAt);
    if (at && at.getTime() < Date.now() - SCHEDULE_GRACE_MS) throw new ApiError(400, 'time_in_past');

    const [session, examiner] = await Promise.all([
      this.prisma.stageExamSession.findFirst({
        where: { id: sessionId, ...this.inReach(staff), status: { in: [...OPEN] } },
        select: { status: true, stage: true, finalKind: true, examinerId: true, studentId: true, student: { select: { fullName: true, section: true, timeZone: true } } },
      }),
      this.prisma.user.findFirst({
        where: { id: examinerId, role: 'TEACHER', status: 'ACTIVE', ...(isAdministration(staff) ? {} : { scopeId: staff.scopeId ?? '' }) },
        select: { id: true, section: true },
      }),
    ]);
    if (!session || !examiner) throw notFound();
    if (session.status === 'IN_PROGRESS') throw new ApiError(409, 'exam_in_progress');
    // A man examines the men's section, and a woman the women's.
    if (session.student.section !== examiner.section) throw new ApiError(409, 'section_mismatch');

    const row = await this.prisma.$transaction(async (tx) => {
      // A booked time belongs to the teacher who offered it, so a new examiner or time frees it.
      await tx.admissionSlot.updateMany({ where: { stageSessionId: sessionId }, data: { stageSessionId: null } });
      const { count } = await tx.stageExamSession.updateMany({
        where: { id: sessionId, status: { in: ['WAITING', 'SCHEDULED'] } },
        data: { examinerId, scheduledAt: at, status: at ? 'SCHEDULED' : 'WAITING' },
      });
      if (count !== 1) throw new ApiError(409, 'exam_in_progress');
      return tx.stageExamSession.findUniqueOrThrow({ where: { id: sessionId }, select: SESSION_SELECT });
    });

    const label = examLabel(session.stage, session.finalKind);
    if (at) {
      await this.notifications.send([session.studentId], {
        type: 'EVALUATION',
        title: `تحدد موعد ${examNoun(session.finalKind)} · ${label}`,
        body: `موعد اختبارك المباشر ${formatTime(at, session.student.timeZone)}، {{وستدخل|وستدخلين}} غرفة الاختبار من التطبيق.`,
        dedupeKey: `stage-exam-time:${sessionId}:${at.getTime()}`,
      });
    }
    await this.notifications.send([examinerId], {
      type: 'GENERAL',
      title: session.examinerId !== examinerId ? 'أُسند إليك اختبار مرحلي' : at ? 'تحدد موعد اختبار مرحلي' : 'أُلغي موعد اختبار مرحلي',
      body: `${session.student.fullName} · ${label}${at ? ` · ${formatTime(at, null)}` : ''}`,
    });
    if (session.examinerId && session.examinerId !== examinerId) {
      await this.notifications.send([session.examinerId], {
        type: 'GENERAL',
        title: 'نُقل اختبار مرحلي إلى {{معلم آخر|معلمة أخرى}}',
        body: `${session.student.fullName} · ${label}`,
      });
    }
    await this.audit.record(staff, 'stage_exam.arrange', { type: 'student', id: session.studentId }, { sessionId, examinerId, scheduledAt });
    return toSession(row);
  }

  /** Withdraws an exam not yet held, as when it was opened by mistake. */
  async cancel(staff: StaffActor, sessionId: string): Promise<void> {
    const session = await this.prisma.stageExamSession.findFirst({
      where: { id: sessionId, ...this.inReach(staff) },
      select: { studentId: true, stage: true, finalKind: true, examinerId: true, status: true },
    });
    if (!session) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.stageExamSession.updateMany({ where: { id: sessionId, status: { in: ['WAITING', 'SCHEDULED'] } }, data: { status: 'CANCELLED' } });
      if (count !== 1) throw new ApiError(409, 'invalid_exam_state');
      await tx.admissionSlot.updateMany({ where: { stageSessionId: sessionId }, data: { stageSessionId: null } });
    });

    const message = { type: 'GENERAL' as const, title: `أُلغي ${examNoun(session.finalKind)}`, body: examLabel(session.stage, session.finalKind), dedupeKey: `stage-exam-cancel:${sessionId}` };
    await this.notifications.send(session.examinerId ? [session.studentId, session.examinerId] : [session.studentId], message);
    await this.audit.record(staff, 'stage_exam.cancel', { type: 'student', id: session.studentId }, { sessionId });
  }

  // ---------- Examiner ----------

  /** The exams given to this teacher: open ones by time, then those she held without recording a result. */
  async examinerList(teacher: StaffActor) {
    const [{ scheduling }, { passScore }, rows] = await Promise.all([
      this.settings.get('stageExam'),
      this.settings.get('gate'),
      this.prisma.stageExamSession.findMany({
        where: { examinerId: teacher.id, OR: [{ status: { in: [...OPEN] } }, { status: 'COMPLETED', examId: null }] },
        orderBy: [{ scheduledAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: 200,
        select: {
          ...SESSION_SELECT,
          circle: { select: { name: true } },
          student: { select: { id: true, fullName: true, phone: true } },
        },
      }),
    ]);
    return {
      scheduling,
      /** Whether this teacher sets the times herself. */
      canSchedule: scheduling === 'TEACHER',
      passScore,
      items: rows.map(({ circle, student, ...row }) => ({
        ...toSession(row),
        circle: circle?.name ?? null,
        student: { id: student.id, name: student.fullName, phone: student.phone },
      })),
    };
  }

  /** Sets the time, when the settings leave it to the examiner. */
  async examinerSchedule(teacher: StaffActor, sessionId: string, scheduledAt: string) {
    const { scheduling } = await this.settings.get('stageExam');
    if (scheduling !== 'TEACHER') throw new ApiError(409, scheduling === 'STUDENT' ? 'student_picks_time' : 'supervisor_picks_time');
    const at = new Date(scheduledAt);
    if (at.getTime() < Date.now() - SCHEDULE_GRACE_MS) throw new ApiError(400, 'time_in_past');

    const row = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.stageExamSession.updateMany({
        where: { id: sessionId, examinerId: teacher.id, status: { in: ['WAITING', 'SCHEDULED'] } },
        data: { scheduledAt: at, status: 'SCHEDULED' },
      });
      if (count !== 1) throw await this.stateError(teacher, sessionId);
      return tx.stageExamSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { ...SESSION_SELECT, studentId: true, circle: { select: { scopeId: true } }, student: { select: { fullName: true, timeZone: true } } },
      });
    });

    const label = examLabel(row.stage, row.finalKind);
    await this.notifications.send([row.studentId], {
      type: 'EVALUATION',
      title: `تحدد موعد ${examNoun(row.finalKind)} · ${label}`,
      body: `موعد اختبارك المباشر ${formatTime(at, row.student.timeZone)}، {{وستدخل|وستدخلين}} غرفة الاختبار من التطبيق.`,
      dedupeKey: `stage-exam-time:${sessionId}:${at.getTime()}`,
    });
    if (row.circle) {
      await this.notifications.notifySupervisorsOf(row.circle.scopeId, {
        type: 'GENERAL',
        title: 'تحدد موعد اختبار مرحلي',
        body: `${row.student.fullName} · ${label} · ${formatTime(at, null)}`,
      });
    }
    await this.audit.record(teacher, 'stage_exam.schedule', { type: 'student', id: row.studentId }, { sessionId, scheduledAt });
    const { studentId: _studentId, circle: _circle, student: _student, ...session } = row;
    return toSession(session);
  }

  async start(teacher: StaffActor, sessionId: string): Promise<void> {
    const { count } = await this.prisma.stageExamSession.updateMany({
      where: { id: sessionId, examinerId: teacher.id, status: { in: ['WAITING', 'SCHEDULED'] } },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    if (count !== 1) throw await this.stateError(teacher, sessionId);
    const session = await this.prisma.stageExamSession.findUniqueOrThrow({ where: { id: sessionId }, select: { studentId: true, stage: true, finalKind: true } });
    await this.notifications.send([session.studentId], {
      type: 'EVALUATION',
      title: `بدأ ${examNoun(session.finalKind)} · ${examLabel(session.stage, session.finalKind)}`,
      body: '{{المعلم|المعلمة}} في غرفة الاختبار الآن، {{فادخل|فادخلي}} من التطبيق.',
      dedupeKey: `stage-exam-start:${sessionId}`,
    });
  }

  async end(teacher: StaffActor, sessionId: string): Promise<void> {
    const { count } = await this.prisma.stageExamSession.updateMany({
      where: { id: sessionId, examinerId: teacher.id, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', endedAt: new Date() },
    });
    if (count !== 1) throw await this.stateError(teacher, sessionId);
    this.voice.endStageExamRoom(sessionId);
  }

  // ---------- Scoring, by the examiner ----------

  /** Today's rules from the settings. A review track's final test passes at the track's own score, when it sets one. */
  private async currentRules(final?: { studentId: string } | null): Promise<ScoringRules> {
    const { deductions, minSurahs, passScore } = await this.settings.get('stageExam');
    if (!final) return { deductions, minSurahs, passScore };
    const plan = await this.prisma.studentPlan.findUnique({ where: { studentId: final.studentId }, select: { template: { select: { reviewPassScore: true } } } });
    const own = plan?.template.reviewPassScore;
    return { deductions, minSurahs, passScore: own == null ? passScore : Number(own) };
  }

  /** The surahs an exam tests: the seventh's, or for a final test the whole scope of the student's plan. */
  private async examSurahs(studentId: string, stage: number, finalKind: ReviewFinalKind | null): Promise<number[]> {
    if (!finalKind) return surahsOfSeventh(stage, (await this.settings.get('stageExam')).division, SURAH_PAGES);
    const plan = await this.prisma.studentPlan.findUnique({ where: { studentId }, select: { surahOrder: true, pageRange: true } });
    return plan ? scopeSurahs(plan) : [];
  }

  /** The exam with its surahs and mistakes, as the examiner scores it. The supervisor reads the same sheet. */
  async sheet(staff: StaffActor, sessionId: string) {
    const where: Prisma.StageExamSessionWhereInput =
      staff.role === 'TEACHER' ? { id: sessionId, examinerId: staff.id } : { id: sessionId, ...this.inReach(staff) };
    const row = await this.prisma.stageExamSession.findFirst({
      where,
      select: {
        ...SESSION_SELECT,
        scoring: true,
        circle: { select: { name: true } },
        student: { select: { id: true, fullName: true } },
        items: ITEMS_SELECT,
      },
    });
    if (!row) throw notFound();
    const { scoring, circle, student, items, ...session } = row;
    const [current, surahs] = await Promise.all([
      this.currentRules(session.finalKind ? { studentId: student.id } : null),
      this.examSurahs(student.id, session.stage, session.finalKind),
    ]);
    const rules = rulesOf(scoring, current);
    const described = describeItems(items, rules);
    return {
      ...toSession(session),
      circle: circle?.name ?? null,
      student: { id: student.id, name: student.fullName },
      rules,
      /** The surahs the examiner may choose from: those of the seventh being tested, or the review's whole scope. */
      surahs,
      /** Whether surahs and mistakes can still change: during the exam, or after it until the result is recorded. */
      editable: !session.exam && (session.status === 'IN_PROGRESS' || session.status === 'COMPLETED'),
      items: described,
      /** The score the result would have now. Null once recorded, or with no surahs yet. */
      running: session.exam ? null : examScore(described.map(({ counts }) => counts), rules),
    };
  }

  /** The exam this examiner may still score, or why not. */
  private async editable(teacher: StaffActor, sessionId: string) {
    const session = await this.prisma.stageExamSession.findFirst({
      where: { id: sessionId, examinerId: teacher.id, examId: null, status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
      select: { id: true, stage: true, finalKind: true, studentId: true },
    });
    if (!session) throw await this.stateError(teacher, sessionId);
    return session;
  }

  /** A surah, or part of one, the student is to recite. It must lie in the seventh being tested. */
  async addItem(teacher: StaffActor, sessionId: string, { surah, fromAyah, toAyah }: ExamItemInput) {
    const session = await this.editable(teacher, sessionId);
    const info = findSurah(surah);
    if (!info || fromAyah < 1 || toAyah < fromAyah || toAyah > info.ayahCount) throw new ApiError(400, 'invalid_ayah_range');
    if (session.finalKind) {
      if (!(await this.examSurahs(session.studentId, 0, session.finalKind)).includes(surah)) throw new ApiError(409, 'outside_scope');
    } else {
      const page = SURAH_PAGES[surah].find(([, first, , last]) => fromAyah >= first && fromAyah <= last)![0];
      const { division } = await this.settings.get('stageExam');
      if (seventhOf({ surah, page }, division) !== session.stage) throw new ApiError(409, 'outside_seventh');
    }

    const item = await this.prisma.stageExamItem.create({ data: { sessionId, surah, fromAyah, toAyah }, select: ITEMS_SELECT.select });
    return describeItems([item], await this.currentRules(session.finalKind ? session : null))[0];
  }

  async removeItem(teacher: StaffActor, sessionId: string, itemId: string): Promise<void> {
    await this.editable(teacher, sessionId);
    const { count } = await this.prisma.stageExamItem.deleteMany({ where: { id: itemId, sessionId } });
    if (count !== 1) throw notFound();
  }

  async addMark(teacher: StaffActor, sessionId: string, itemId: string, kind: StageExamMarkKind, note: string | null) {
    await this.editable(teacher, sessionId);
    if ((await this.prisma.stageExamItem.count({ where: { id: itemId, sessionId } })) === 0) throw notFound();
    const mark = await this.prisma.stageExamMark.create({ data: { itemId, kind, note }, select: { id: true, kind: true, note: true, createdAt: true } });
    return { ...mark, label: MARK_LABELS[mark.kind] };
  }

  /** Undoes a mistake recorded by mistake. */
  async removeMark(teacher: StaffActor, sessionId: string, markId: string): Promise<void> {
    await this.editable(teacher, sessionId);
    const { count } = await this.prisma.stageExamMark.deleteMany({ where: { id: markId, item: { sessionId } } });
    if (count !== 1) throw notFound();
  }

  /**
   * Records the result, computed from the mistakes by the settings' rules: the examiner can't set it by hand. The
   * rules and each surah's score are kept with it. Below the pass score, a retake opens.
   */
  async recordResult(teacher: StaffActor, sessionId: string, note: string | null) {
    const session = await this.prisma.stageExamSession.findFirst({
      where: { id: sessionId, examinerId: teacher.id, status: { in: ['IN_PROGRESS', 'COMPLETED'] }, examId: null },
      select: {
        studentId: true,
        circleId: true,
        stage: true,
        finalKind: true,
        status: true,
        student: { select: { fullName: true } },
        circle: { select: { teacherId: true, scopeId: true } },
        items: ITEMS_SELECT,
      },
    });
    if (!session) throw await this.stateError(teacher, sessionId);

    const rules = await this.currentRules(session.finalKind ? session : null);
    if (session.items.length < rules.minSurahs) throw new ApiError(409, 'too_few_surahs');
    const described = describeItems(session.items, rules);
    const { score, passed } = examScore(described.map(({ counts }) => counts), rules)!;

    const exam = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stageExam.create({
        data: { studentId: session.studentId, teacherId: teacher.id, circleId: session.circleId, stage: session.stage, finalKind: session.finalKind, score, passed },
        select: { id: true },
      });
      const { count } = await tx.stageExamSession.updateMany({
        where: { id: sessionId, examId: null, status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
        data: {
          examId: created.id,
          status: 'COMPLETED',
          scoring: rules as unknown as Prisma.InputJsonValue,
          note,
          ...(session.status === 'IN_PROGRESS' ? { endedAt: new Date() } : {}),
        },
      });
      if (count !== 1) throw new ApiError(409, 'result_recorded');
      for (const item of described) await tx.stageExamItem.update({ where: { id: item.id }, data: { score: item.score } });
      return created;
    });
    if (session.status === 'IN_PROGRESS') this.voice.endStageExamRoom(sessionId);

    const label = examLabel(session.stage, session.finalKind);
    // What follows a final test's failure depends on the track, so the review service tells the student.
    const failure = session.finalKind ? 'لم {{تجتز|تجتازي}} هذه المرة' : '{{ستعيد|ستعيدين}} الاختبار في موعد جديد';
    await this.notifications.send([session.studentId], {
      type: 'EVALUATION',
      title: `نتيجة ${examNoun(session.finalKind)}`,
      body: `${label}: ${score} من 10 · ${passed ? 'ناجحة، بارك الله فيك' : failure}`,
      dedupeKey: `stage-exam:${exam.id}`,
    });
    const staffMessage = {
      type: 'GENERAL' as const,
      title: session.finalKind ? (passed ? `اجتياز ${label}` : `لم يُجتز ${label}`) : passed ? 'اجتياز اختبار مرحلي' : 'لم يُجتز اختبار مرحلي',
      body: `${session.student.fullName} · ${label} · ${score} من 10`,
      dedupeKey: `stage-exam-result:${exam.id}`,
    };
    if (session.circle?.teacherId && session.circle.teacherId !== teacher.id) await this.notifications.send([session.circle.teacherId], staffMessage);
    if (session.circle) await this.notifications.notifySupervisorsOf(session.circle.scopeId, staffMessage);
    await this.audit.record(teacher, 'stage_exam.result', { type: 'student', id: session.studentId }, { sessionId, stage: session.stage, score });

    if (!passed && !session.finalKind) await this.open(session.studentId, session.stage, true, teacher.id);
    return { id: exam.id, score, passed, studentId: session.studentId, finalKind: session.finalKind };
  }

  /** A pass recorded by hand, outside the live exam, settles that seventh: its open exam has nothing left to test. */
  async settledByHand(studentId: string, stage: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.admissionSlot.updateMany({ where: { stageSession: { studentId, stage, status: { in: ['WAITING', 'SCHEDULED'] } } }, data: { stageSessionId: null } }),
      this.prisma.stageExamSession.updateMany({ where: { studentId, stage, status: { in: ['WAITING', 'SCHEDULED'] } }, data: { status: 'CANCELLED' } }),
    ]);
  }

  voiceTicketForExaminer(teacher: StaffActor, sessionId: string) {
    return this.voice.ticketForStageExamTeacher(teacher.id, sessionId);
  }

  private async stateError(teacher: StaffActor, sessionId: string): Promise<ApiError> {
    const exists = await this.prisma.stageExamSession.count({ where: { id: sessionId, examinerId: teacher.id } });
    return exists ? new ApiError(409, 'invalid_exam_state') : notFound();
  }

  // ---------- Student ----------

  /** Her open exams, each with the examiner's free times when she may book one, and her past results. */
  async forStudent(studentId: string) {
    const [{ scheduling }, plan, open, history, current] = await Promise.all([
      this.settings.get('stageExam'),
      this.prisma.studentPlan.findUnique({ where: { studentId }, select: { template: { select: { stageExamMode: true } } } }),
      this.prisma.stageExamSession.findMany({
        where: { studentId, status: { in: [...OPEN] } },
        orderBy: { stage: 'asc' },
        select: { ...SESSION_SELECT, examinerId: true },
      }),
      this.prisma.stageExam.findMany({
        where: { studentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          stage: true,
          finalKind: true,
          score: true,
          passed: true,
          createdAt: true,
          session: { select: { scoring: true, note: true, items: ITEMS_SELECT } },
        },
      }),
      this.currentRules(),
    ]);
    const exams = await Promise.all(
      open.map(async ({ examinerId, ...row }) => {
        const canBook = scheduling === 'STUDENT' && row.status === 'WAITING' && examinerId !== null;
        const slots = canBook
          ? await this.prisma.admissionSlot.findMany({
              where: { teacherId: examinerId!, testId: null, stageSessionId: null, startsAt: { gt: new Date() } },
              orderBy: { startsAt: 'asc' },
              take: 30,
              select: { id: true, startsAt: true },
            })
          : [];
        return { ...toSession(row), canBook, slots };
      }),
    );
    const mode = plan?.template.stageExamMode ?? 'OFF';
    return {
      mode,
      /** New memorization waits for these exams. A review track's final test isn't one of them. */
      holdsBack: mode === 'BLOCKING' && exams.some((exam) => exam.finalKind === null),
      exams,
      // A result recorded by hand has no surahs.
      history: history.map(({ session, ...row }) => ({
        ...row,
        label: examLabel(row.stage, row.finalKind),
        score: Number(row.score),
        note: session?.note ?? null,
        items: session ? describeItems(session.items, rulesOf(session.scoring, current)).map(({ marks: _marks, ...item }) => item) : [],
      })),
    };
  }

  /** Books one of the examiner's free times. Two students taking the same time can't both get it. */
  async book(studentId: string, sessionId: string, slotId: string) {
    const { scheduling } = await this.settings.get('stageExam');
    if (scheduling !== 'STUDENT') throw new ApiError(409, 'staff_picks_time');

    const booked = await this.prisma.$transaction(async (tx) => {
      const session = await tx.stageExamSession.findFirst({
        where: { id: sessionId, studentId, status: 'WAITING', examinerId: { not: null } },
        select: { examinerId: true },
      });
      if (!session) throw new ApiError(409, 'nothing_to_book');
      const slot = await tx.admissionSlot.findFirst({
        where: { id: slotId, teacherId: session.examinerId!, startsAt: { gt: new Date() } },
        select: { startsAt: true },
      });
      if (!slot) throw notFound();
      const { count } = await tx.admissionSlot.updateMany({ where: { id: slotId, testId: null, stageSessionId: null }, data: { stageSessionId: sessionId } });
      if (count !== 1) throw new ApiError(409, 'slot_taken');
      return tx.stageExamSession.update({
        where: { id: sessionId },
        data: { scheduledAt: slot.startsAt, status: 'SCHEDULED' },
        select: { ...SESSION_SELECT, student: { select: { fullName: true } }, circle: { select: { scopeId: true } } },
      });
    });

    const body = `${booked.student.fullName} · ${examLabel(booked.stage, booked.finalKind)} · ${formatTime(booked.scheduledAt!, null)}`;
    if (booked.examiner) await this.notifications.send([booked.examiner.id], { type: 'GENERAL', title: 'حُجز موعد اختبار مرحلي', body });
    if (booked.circle) await this.notifications.notifySupervisorsOf(booked.circle.scopeId, { type: 'GENERAL', title: 'حُجز موعد اختبار مرحلي', body });
    const { student: _student, circle: _circle, ...session } = booked;
    return toSession(session);
  }

  voiceTicketForStudent(studentId: string, sessionId: string) {
    return this.voice.ticketForStageExamStudent(studentId, sessionId);
  }
}
