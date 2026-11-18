import { Injectable } from '@nestjs/common';
import { isAdministration, type StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { assertTrackFitsSection, trackFitsSection } from '../common/sections.js';
import { isUniqueViolation } from '../common/staff-api.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VoiceService } from '../voice/voice.service.js';
import { NotificationsService } from './notifications.service.js';
import { PlanService } from './plan.service.js';
import { SettingsService } from './settings.service.js';
import { ORIGINAL_TRACK } from './track-change.service.js';

export interface AdmissionDecision {
  accepted: boolean;
  score: number | null;
  note: string | null;
  /**
   * The track the tester puts the student on when accepting. Left out, the student keeps the track she has,
   * or chooses one herself in the app once accepted.
   */
  trackId?: string | null;
  /** Where the stabilization track begins. Al-Kahf when not given. */
  trackStart?: 'KAHF' | 'FATIHA' | null;
}

export interface AssignTest {
  teacherId: string;
  /** ISO time. Null leaves it open, for the student to book or the supervisor to set later. */
  scheduledAt: string | null;
}

const OPEN = ['SCHEDULED', 'IN_PROGRESS'] as const;
const FALLBACK_TIME_ZONE = 'Asia/Riyadh';
// Allows for a slow request when picking a time that starts now.
const SCHEDULE_GRACE_MS = 5 * 60 * 1000;
const SLOT_LIMIT = 60;

const notFound = () => new ApiError(404, 'not_found');

const TEST_SELECT = {
  id: true,
  status: true,
  scheduledAt: true,
  startedAt: true,
  teacher: { select: { id: true, fullName: true } },
} satisfies Prisma.AdmissionTestSelect;

type TestRow = Prisma.AdmissionTestGetPayload<{ select: typeof TEST_SELECT }>;

const toTest = (row: TestRow) => ({
  id: row.id,
  status: row.status,
  scheduledAt: row.scheduledAt,
  startedAt: row.startedAt,
  teacher: row.teacher ? { id: row.teacher.id, name: row.teacher.fullName } : null,
});

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

/**
 * The recitation test before a student starts. The supervisor assigns a teacher, the time is set by
 * whoever the settings allow, the teacher tests her in the admission room, and records the result.
 * A student's plan begins only once accepted.
 */
@Injectable()
export class AdmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly voice: VoiceService,
    private readonly audit: AuditService,
  ) {}

  // ---------- Supervisor and administration ----------

  /** Waiting students first. The phone number is here because whoever runs the test must reach them. */
  async list() {
    const [{ scheduling }, rows] = await Promise.all([
      this.settings.get('admission'),
      this.prisma.user.findMany({
        where: { role: 'STUDENT', admissionStatus: { in: ['PENDING', 'REJECTED'] } },
        orderBy: [{ admissionStatus: 'asc' }, { createdAt: 'asc' }],
        take: 200,
        select: {
          id: true,
          fullName: true,
          phone: true,
          country: true,
          ageBand: true,
          section: true,
          createdAt: true,
          admissionStatus: true,
          admissionScore: true,
          admissionNote: true,
          admissionDecidedAt: true,
          trackTemplate: { select: { name: true } },
          admissionTests: { where: { status: { in: [...OPEN] } }, take: 1, select: TEST_SELECT },
        },
      }),
    ]);
    return {
      scheduling,
      applicants: rows.map((row) => ({
        id: row.id,
        name: row.fullName,
        phone: row.phone,
        country: row.country,
        ageBand: row.ageBand,
        section: row.section,
        track: row.trackTemplate?.name ?? null,
        createdAt: row.createdAt,
        status: row.admissionStatus,
        score: row.admissionScore === null ? null : Number(row.admissionScore),
        note: row.admissionNote,
        decidedAt: row.admissionDecidedAt,
        test: row.admissionTests[0] ? toTest(row.admissionTests[0]) : null,
      })),
    };
  }

  /** Teachers a supervisor may give a test to: her own scope's. The administration sees every active teacher. */
  async teachers(staff: StaffActor) {
    const rows = await this.prisma.user.findMany({
      where: { role: 'TEACHER', status: 'ACTIVE', ...(isAdministration(staff) ? {} : { scopeId: staff.scopeId ?? '' }) },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, section: true, scope: { select: { name: true } } },
    });
    return rows.map((row) => ({ id: row.id, name: row.fullName, section: row.section, scope: row.scope?.name ?? null }));
  }

  /** Gives the test to a teacher, or moves it to another teacher or time. A test in progress can't move. */
  async assign(staff: StaffActor, studentId: string, { teacherId, scheduledAt }: AssignTest) {
    const { scheduling } = await this.settings.get('admission');
    if (scheduledAt !== null && scheduling === 'STUDENT') throw new ApiError(409, 'student_picks_time');
    const at = scheduledAt === null ? null : new Date(scheduledAt);
    if (at && at.getTime() < Date.now() - SCHEDULE_GRACE_MS) throw new ApiError(400, 'time_in_past');

    const [student, teacher] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: studentId, role: 'STUDENT', admissionStatus: { in: ['PENDING', 'REJECTED'] } },
        select: { id: true, fullName: true, timeZone: true, section: true },
      }),
      this.prisma.user.findFirst({
        where: { id: teacherId, role: 'TEACHER', status: 'ACTIVE', ...(isAdministration(staff) ? {} : { scopeId: staff.scopeId ?? '' }) },
        select: { id: true, section: true },
      }),
    ]);
    if (!student || !teacher) throw notFound();
    // A man tests the men's section, and a woman the women's.
    if (student.section !== teacher.section) throw new ApiError(409, 'section_mismatch');

    const test = await this.prisma.$transaction(async (tx) => {
      const open = await tx.admissionTest.findFirst({ where: { studentId, status: { in: [...OPEN] } }, select: { id: true, status: true } });
      if (open?.status === 'IN_PROGRESS') throw new ApiError(409, 'test_in_progress');
      if (open) {
        // A booked time belongs to the teacher who offered it, so a new teacher or time frees it.
        await tx.admissionSlot.updateMany({ where: { testId: open.id }, data: { testId: null } });
        return tx.admissionTest.update({ where: { id: open.id }, data: { teacherId, scheduledAt: at }, select: TEST_SELECT });
      }
      return tx.admissionTest.create({ data: { studentId, teacherId, scheduledAt: at }, select: TEST_SELECT });
    });

    const studentMayBook = at === null && scheduling !== 'SUPERVISOR';
    await this.notifications.send([studentId], {
      type: 'GENERAL',
      title: at ? 'تحدد موعد اختبار القبول' : 'اختبار القبول',
      body: at
        ? `موعد اختبار التلاوة ${formatTime(at, student.timeZone)}، {{وستدخل|وستدخلين}} غرفة الاختبار من التطبيق.`
        : studentMayBook
          ? '{{اختر|اختاري}} موعدًا مناسبًا لاختبار التلاوة من التطبيق.'
          : 'ستحدد الإدارة موعد اختبار التلاوة قريبًا.',
    });
    await this.notifications.send([teacherId], {
      type: 'GENERAL',
      title: 'أُسند إليك اختبار قبول',
      body: at ? `${student.fullName} · ${formatTime(at, null)}` : student.fullName,
    });
    await this.audit.record(staff, 'admission.assign', { type: 'student', id: studentId }, { teacherId, scheduledAt });
    return toTest(test);
  }

  /** The tracks a tester may put a student on. A track with online recitation is for the women's section only. */
  async tracks() {
    const rows = await this.prisma.trackTemplate.findMany({
      // A review track is given after the test too, to a student who holds what it reviews.
      where: { active: true, kind: { in: ['MEMORIZATION', 'REVIEW'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, name: true, kind: true, recitationMode: true },
    });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      forMen: trackFitsSection(row.recitationMode, 'MEN'),
      forWomen: trackFitsSection(row.recitationMode, 'WOMEN'),
    }));
  }

  /** Records the result. The supervisor may, and so may the teacher who gave the test. */
  async decide(staff: StaffActor, studentId: string, { accepted, score, note, trackId, trackStart }: AdmissionDecision): Promise<void> {
    const student = await this.prisma.user.findFirst({
      where: { id: studentId, role: 'STUDENT', admissionStatus: { in: ['PENDING', 'REJECTED'] } },
      select: { section: true, trackStart: true, trackTemplateId: true },
    });
    if (!student) throw notFound();

    // The tester may choose the track on acceptance. Otherwise the student chooses it in the app.
    let trackData: Pick<Prisma.UserUncheckedUpdateManyInput, 'trackTemplateId' | 'trackId' | 'trackStart'> = {};
    if (accepted && trackId) {
      const track = await this.prisma.trackTemplate.findFirst({
        where: { id: trackId, active: true, kind: { in: ['MEMORIZATION', 'REVIEW'] } },
        select: { id: true, code: true, recitationMode: true },
      });
      if (!track) throw new ApiError(409, 'track_closed');
      assertTrackFitsSection(track.recitationMode, student.section);
      const isStabilization = track.code === 'stabilization';
      trackData = {
        trackTemplateId: track.id,
        trackId: ORIGINAL_TRACK[track.code as keyof typeof ORIGINAL_TRACK] ?? null,
        // Only the stabilization track has a starting point.
        trackStart: isStabilization ? (trackStart ?? student.trackStart ?? 'KAHF') : null,
      };
    }

    const { count } = await this.prisma.user.updateMany({
      where: { id: studentId, role: 'STUDENT', admissionStatus: { in: ['PENDING', 'REJECTED'] } },
      data: {
        admissionStatus: accepted ? 'ACCEPTED' : 'REJECTED',
        admissionScore: score,
        admissionNote: note,
        admissionDecidedAt: new Date(),
        ...trackData,
      },
    });
    if (count !== 1) throw notFound();

    await this.closeOpenTests(studentId);
    if (accepted) await this.plans.startPlan(studentId);
    const hasTrack = Boolean(trackData.trackTemplateId ?? student.trackTemplateId);
    await this.notifications.send([studentId], {
      type: 'GENERAL',
      title: accepted ? 'تم قبولك في البرنامج' : 'نتيجة اختبار القبول',
      body: accepted
        ? hasTrack
          ? '{{اجتزت|اجتزتِ}} اختبار التلاوة، وبدأت خطتك الآن. بارك الله فيك.'
          : '{{اجتزت|اجتزتِ}} اختبار التلاوة. {{اختر|اختاري}} مسارك من التطبيق لتبدأ خطتك. بارك الله فيك.'
        : (note ?? 'لم يتم القبول هذه المرة، ويمكنك إعادة الاختبار لاحقًا.'),
    });
    await this.audit.record(staff, accepted ? 'admission.accept' : 'admission.reject', { type: 'student', id: studentId }, { score, trackId: trackData.trackTemplateId ?? null });
  }

  /** A decision ends whatever test was still open: one in the room is finished, one not yet held is cancelled. */
  private async closeOpenTests(studentId: string): Promise<void> {
    const open = await this.prisma.admissionTest.findMany({ where: { studentId, status: { in: [...OPEN] } }, select: { id: true, status: true } });
    for (const test of open) {
      if (test.status === 'IN_PROGRESS') {
        await this.prisma.admissionTest.updateMany({ where: { id: test.id, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', endedAt: new Date() } });
        this.voice.endAdmissionRoom(test.id);
      } else {
        await this.prisma.$transaction([
          this.prisma.admissionSlot.updateMany({ where: { testId: test.id }, data: { testId: null } }),
          this.prisma.admissionTest.updateMany({ where: { id: test.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } }),
        ]);
      }
    }
  }

  // ---------- Teacher ----------

  /** The tests given to this teacher: open ones by time, then those she finished without a decision yet. */
  async teacherTests(teacher: StaffActor) {
    const rows = await this.prisma.admissionTest.findMany({
      where: {
        teacherId: teacher.id,
        OR: [{ status: { in: [...OPEN] } }, { status: 'COMPLETED', student: { admissionStatus: 'PENDING' } }],
      },
      orderBy: [{ scheduledAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: 200,
      select: {
        ...TEST_SELECT,
        endedAt: true,
        student: { select: { id: true, fullName: true, phone: true, country: true, ageBand: true, section: true, trackTemplate: { select: { name: true } } } },
      },
    });
    return rows.map(({ student, endedAt, ...row }) => ({
      ...toTest(row),
      endedAt,
      student: {
        id: student.id,
        name: student.fullName,
        phone: student.phone,
        country: student.country,
        ageBand: student.ageBand,
        section: student.section,
        track: student.trackTemplate?.name ?? null,
      },
    }));
  }

  async start(teacher: StaffActor, testId: string) {
    const { count } = await this.prisma.admissionTest.updateMany({
      where: { id: testId, teacherId: teacher.id, status: 'SCHEDULED' },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    if (count !== 1) throw await this.stateError(teacher, testId);
    const test = await this.prisma.admissionTest.findUniqueOrThrow({ where: { id: testId }, select: { studentId: true } });
    await this.notifications.send([test.studentId], {
      type: 'GENERAL',
      title: 'بدأ اختبار القبول',
      body: '{{المعلم|المعلمة}} في غرفة الاختبار الآن، {{فادخل|فادخلي}} من التطبيق.',
    });
  }

  async end(teacher: StaffActor, testId: string) {
    const { count } = await this.prisma.admissionTest.updateMany({
      where: { id: testId, teacherId: teacher.id, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', endedAt: new Date() },
    });
    if (count !== 1) throw await this.stateError(teacher, testId);
    this.voice.endAdmissionRoom(testId);
  }

  /** The teacher who gave the test records its result, during it or after. */
  async teacherDecide(teacher: StaffActor, testId: string, decision: AdmissionDecision) {
    const test = await this.prisma.admissionTest.findFirst({
      where: { id: testId, teacherId: teacher.id, status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
      select: { studentId: true },
    });
    if (!test) throw await this.stateError(teacher, testId);
    await this.decide(teacher, test.studentId, decision);
  }

  async slots(teacher: StaffActor) {
    const rows = await this.prisma.admissionSlot.findMany({
      where: {
        teacherId: teacher.id,
        OR: [
          { startsAt: { gte: new Date() } },
          { test: { status: { in: [...OPEN] } } },
          { stageSession: { status: { in: ['WAITING', 'SCHEDULED', 'IN_PROGRESS'] } } },
        ],
      },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        startsAt: true,
        test: { select: { student: { select: { fullName: true } } } },
        stageSession: { select: { stage: true, student: { select: { fullName: true } } } },
      },
    });
    // A time is shared by admission tests and stage exams, so it shows whichever booked it.
    return rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt,
      bookedBy: row.test?.student.fullName ?? row.stageSession?.student.fullName ?? null,
      bookedFor: row.test ? ('ADMISSION' as const) : row.stageSession ? ('STAGE_EXAM' as const) : null,
    }));
  }

  async addSlot(teacher: StaffActor, startsAt: string) {
    const at = new Date(startsAt);
    if (at.getTime() < Date.now()) throw new ApiError(400, 'time_in_past');
    const upcoming = await this.prisma.admissionSlot.count({ where: { teacherId: teacher.id, startsAt: { gte: new Date() } } });
    if (upcoming >= SLOT_LIMIT) throw new ApiError(409, 'too_many_slots');
    try {
      const slot = await this.prisma.admissionSlot.create({ data: { teacherId: teacher.id, startsAt: at }, select: { id: true, startsAt: true } });
      return { ...slot, bookedBy: null, bookedFor: null };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'slot_exists');
      throw error;
    }
  }

  /** Only a free time can be removed. A booked one has a student counting on it. */
  async removeSlot(teacher: StaffActor, slotId: string): Promise<void> {
    const { count } = await this.prisma.admissionSlot.deleteMany({ where: { id: slotId, teacherId: teacher.id, testId: null, stageSessionId: null } });
    if (count === 1) return;
    const exists = await this.prisma.admissionSlot.count({ where: { id: slotId, teacherId: teacher.id } });
    throw exists ? new ApiError(409, 'slot_booked') : notFound();
  }

  voiceTicketForTeacher(teacher: StaffActor, testId: string) {
    return this.voice.ticketForAdmissionTeacher(teacher.id, testId);
  }

  private async stateError(teacher: StaffActor, testId: string): Promise<ApiError> {
    const exists = await this.prisma.admissionTest.count({ where: { id: testId, teacherId: teacher.id } });
    return exists ? new ApiError(409, 'invalid_test_state') : notFound();
  }

  // ---------- Student ----------

  /** The student's own test, and the teacher's free times when she may book one. */
  async forStudent(studentId: string) {
    const [{ scheduling }, row] = await Promise.all([
      this.settings.get('admission'),
      this.prisma.admissionTest.findFirst({
        where: { studentId, status: { in: [...OPEN] } },
        orderBy: { createdAt: 'desc' },
        select: { ...TEST_SELECT, teacherId: true },
      }),
    ]);
    const canBook = Boolean(row && row.status === 'SCHEDULED' && row.scheduledAt === null && row.teacherId && scheduling !== 'SUPERVISOR');
    const slots = canBook
      ? await this.prisma.admissionSlot.findMany({
          where: { teacherId: row!.teacherId!, testId: null, stageSessionId: null, startsAt: { gt: new Date() } },
          orderBy: { startsAt: 'asc' },
          take: 30,
          select: { id: true, startsAt: true },
        })
      : [];
    return { test: row ? toTest(row) : null, canBook, slots };
  }

  /** Books one of the teacher's free times. Two students taking the same time can't both get it. */
  async book(studentId: string, slotId: string) {
    const { scheduling } = await this.settings.get('admission');
    if (scheduling === 'SUPERVISOR') throw new ApiError(409, 'supervisor_picks_time');

    const booked = await this.prisma.$transaction(async (tx) => {
      const test = await tx.admissionTest.findFirst({
        where: { studentId, status: 'SCHEDULED', scheduledAt: null, teacherId: { not: null } },
        select: { id: true, teacherId: true },
      });
      if (!test) throw new ApiError(409, 'nothing_to_book');
      const slot = await tx.admissionSlot.findFirst({
        where: { id: slotId, teacherId: test.teacherId!, startsAt: { gt: new Date() } },
        select: { startsAt: true },
      });
      if (!slot) throw notFound();
      const { count } = await tx.admissionSlot.updateMany({ where: { id: slotId, testId: null, stageSessionId: null }, data: { testId: test.id } });
      if (count !== 1) throw new ApiError(409, 'slot_taken');
      return tx.admissionTest.update({ where: { id: test.id }, data: { scheduledAt: slot.startsAt }, select: { ...TEST_SELECT, student: { select: { fullName: true } } } });
    });

    if (booked.teacher) {
      await this.notifications.send([booked.teacher.id], {
        type: 'GENERAL',
        title: 'حُجز موعد اختبار قبول',
        body: `${booked.student.fullName} · ${formatTime(booked.scheduledAt!, null)}`,
      });
    }
    const { student: _student, ...test } = booked;
    return toTest(test);
  }

  voiceTicketForStudent(studentId: string, testId: string) {
    return this.voice.ticketForAdmissionStudent(studentId, testId);
  }
}
