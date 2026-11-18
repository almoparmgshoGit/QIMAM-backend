import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { ATTENDANCE_DAY, attendanceRate, isUniqueViolation, pageArgs, riyadhDate, riyadhDayStart } from '../common/staff-api.js';
import { findSurah, SURAHS } from '../common/surahs.js';
import type { AttendanceStatus } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanService, type PlanSummary } from '../program/plan.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { SettingsService } from '../program/settings.service.js';
import { VoiceService } from '../voice/voice.service.js';
import { IsmaService } from './isma.service.js';
import type {
  AttendanceDto,
  AttendanceSheetDto,
  CreateRecitationDto,
  CreateSessionDto,
  CreateTaskDto,
  EvaluateSessionDto,
  ListRecitationsDto,
  ListSessionsDto,
  ListStudentsDto,
  ListTasksDto,
  ReportQueryDto,
  UpdateRecitationDto,
} from './teacher.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What was recited and how it went. Attendance is null for a recording heard after the day it was sent. */
export type EvaluationInput = Omit<EvaluateSessionDto, 'attendance'> & { attendance: EvaluateSessionDto['attendance'] | null };
// Allows for a slow request when scheduling something that starts now.
const SCHEDULE_GRACE_MS = 5 * 60 * 1000;

/** Only the id is read, so the administration can open the same views for a given teacher. */
type TeacherRef = Pick<StaffActor, 'id'>;

// Everything here reaches students only through the teacher's own circles, so the moment a student
// is transferred away, the old teacher loses access. A record outside them answers as if it didn't exist.
const notFound = () => new ApiError(404, 'not_found');

@Injectable()
export class TeacherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly voice: VoiceService,
    private readonly isma: IsmaService,
  ) {}

  surahs() {
    return SURAHS;
  }

  async home(teacher: TeacherRef) {
    const circles = await this.circles(teacher.id);
    const members = await this.prisma.circleMembership.findMany({
      where: { leftAt: null, circleId: { in: circles.map(({ id }) => id) } },
      select: { student: { select: { id: true, fullName: true, trackTemplate: { select: { name: true } } } } },
      orderBy: { joinedAt: 'asc' },
    });
    const studentIds = members.map(({ student }) => student.id);

    // A student has recorded today's wird when a unit of the plan was done today, by her or through a recitation
    // the teacher heard, or when she completed the day's review or consolidation. A skipped surah isn't a wird.
    const today = riyadhDate();
    const [wirdToday, daysToday] = await Promise.all([
      this.prisma.wirdLog.findMany({
        where: { doneOn: today, source: { in: ['STUDENT', 'TEACHER'] }, plan: { studentId: { in: studentIds } } },
        select: { plan: { select: { studentId: true } } },
      }),
      this.prisma.dayCompletion.findMany({ where: { studentId: { in: studentIds }, doneOn: today }, select: { studentId: true } }),
    ]);
    const recorded = new Set([...wirdToday.map(({ plan }) => plan.studentId), ...daysToday.map(({ studentId }) => studentId)]);
    const summaries = await this.plans.summaries(studentIds);

    const tasks = await this.listTasks(teacher, {});
    const nextSession = await this.prisma.liveSession.findFirst({
      where: { teacherId: teacher.id, status: 'SCHEDULED', scheduledAt: { gte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
      include: SESSION_INCLUDE,
    });
    const incomingTransfers = await this.prisma.transferRequest.count({
      where: { status: 'PENDING_TEACHER', toCircle: { teacherId: teacher.id } },
    });

    return {
      circles,
      stats: {
        totalStudents: studentIds.length,
        recordedToday: recorded.size,
        notRecorded: studentIds.length - recorded.size,
        overdueTasks: tasks.filter(({ status }) => status === 'overdue').length,
        incomingTransfers,
        awaitingGates: [...summaries.values()].filter(({ status }) => status === 'awaiting_gate').length,
      },
      today: members.map(({ student }) => ({
        id: student.id,
        name: student.fullName,
        track: student.trackTemplate?.name ?? null,
        recorded: recorded.has(student.id),
        wird: summaries.get(student.id)?.nextLabel ?? null,
        delay: summaries.get(student.id)?.delay ?? null,
      })),
      nextSession: nextSession && toSession(nextSession),
    };
  }

  async listStudents(teacher: TeacherRef, query: ListStudentsDto) {
    const where = {
      leftAt: null,
      circle: { teacherId: teacher.id, archivedAt: null },
      ...(query.search ? { student: { fullName: { contains: query.search, mode: 'insensitive' as const } } } : {}),
    };
    const [total, members] = await Promise.all([
      this.prisma.circleMembership.count({ where }),
      this.prisma.circleMembership.findMany({
        where,
        ...pageArgs(query),
        orderBy: { joinedAt: 'asc' },
        select: {
          circleId: true,
          student: { select: { id: true, fullName: true, trackTemplate: { select: { name: true } } } },
        },
      }),
    ]);

    const ids = members.map(({ student }) => student.id);
    const [latest, attendance] = await Promise.all([
      this.prisma.evaluation.groupBy({ by: ['studentId'], where: { studentId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.evaluation.groupBy({
        by: ['studentId', 'attendance'],
        where: { studentId: { in: ids }, ...ATTENDANCE_DAY },
        _count: true,
      }),
    ]);
    const lastActivity = new Map(latest.map((row) => [row.studentId, row._max.createdAt]));
    const [summaries, repeatedlyAbsent] = await Promise.all([this.plans.summaries(ids), this.repeatedlyAbsent(ids)]);

    return {
      total,
      items: members.map(({ student, circleId }) => ({
        id: student.id,
        name: student.fullName,
        track: student.trackTemplate?.name ?? null,
        circleId,
        lastActivityAt: lastActivity.get(student.id) ?? null,
        attendanceRate: attendanceRate(countsFor(attendance, student.id)),
        ...planFields(summaries.get(student.id), repeatedlyAbsent.has(student.id)),
      })),
    };
  }

  async studentProfile(teacher: StaffActor, studentId: string) {
    const membership = await this.memberOrThrow(teacher.id, studentId);
    const { openRecord } = await this.settings.get('permissions');
    // With the record closed, a teacher sees only what was recorded in this circle.
    return {
      ...(await this.studentFile(studentId, openRecord ? null : membership.circleId)),
      circle: membership.circle,
      joinedAt: membership.joinedAt,
    };
  }

  /** A student's progress, attendance and recitations. Callers check access first; a circle id limits the recitations and attendance to it. */
  async studentFile(studentId: string, onlyCircleId: string | null) {
    const circleLimit = onlyCircleId ? { circleId: onlyCircleId } : {};
    const [student, attendance, evaluations, summaries, week, gates, repeatedlyAbsent] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: studentId },
        // Only what the page needs. The phone number and age stay out of it.
        select: { id: true, fullName: true, country: true, trackTemplate: { select: { name: true } }, trackStart: true },
      }),
      this.prisma.evaluation.groupBy({
        by: ['studentId', 'attendance'],
        where: { studentId, ...ATTENDANCE_DAY, ...circleLimit },
        _count: true,
      }),
      this.prisma.evaluation.findMany({
        where: { studentId, ...circleLimit },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.plans.summaries([studentId]),
      this.plans.weekFor(studentId),
      this.prisma.surahGate.findMany({ where: { studentId }, orderBy: { openedOn: 'desc' } }),
      this.repeatedlyAbsent([studentId]),
    ]);
    const counts = countsFor(attendance, studentId);

    return {
      id: student.id,
      name: student.fullName,
      country: student.country,
      track: student.trackTemplate?.name ?? null,
      trackStart: student.trackStart?.toLowerCase() ?? null,
      attendance: {
        present: counts.PRESENT ?? 0,
        late: counts.LATE ?? 0,
        absent: counts.ABSENT ?? 0,
        rate: attendanceRate(counts),
      },
      ...planFields(summaries.get(studentId), repeatedlyAbsent.has(studentId)),
      week,
      gates: await this.plans.describeGates(gates),
      evaluations: evaluations.map(toEvaluation),
      /** The latest verdict on each recited segment, for the spaced repetition list. */
      segments: evaluations.filter((row) => row.segmentStatus).slice(0, 10).map(toEvaluation),
    };
  }

  async createRecitation(teacher: StaffActor, { studentId, ...fields }: CreateRecitationDto) {
    const { circleId } = await this.memberOrThrow(teacher.id, studentId);
    return toEvaluation(await this.saveEvaluation(teacher, studentId, circleId, fields));
  }

  /** Corrects a recitation this teacher saved, for a student still in her circle. */
  async updateRecitation(teacher: StaffActor, id: string, dto: UpdateRecitationDto) {
    const row = await this.ownRecitation(teacher, id);
    // An absent student recited nothing, so there is nothing to score.
    if (row.attendance === 'ABSENT' && (dto.score !== undefined || (dto.segmentStatus ?? null) !== null)) {
      throw new ApiError(409, 'student_was_absent');
    }
    const updated = await this.prisma.evaluation.update({
      where: { id },
      data: {
        ...(dto.score !== undefined ? { score: dto.score } : {}),
        ...(dto.note !== undefined ? { comment: dto.note || null } : {}),
        ...(dto.segmentStatus !== undefined ? { segmentStatus: dto.segmentStatus } : {}),
      },
    });
    await this.audit.record(teacher, 'evaluation.update', { type: 'student', id: row.studentId }, {
      evaluationId: id,
      scoreFrom: row.score === null ? null : Number(row.score),
      scoreTo: dto.score ?? null,
      noteChanged: dto.note !== undefined,
    });
    return toEvaluation(updated);
  }

  /**
   * Removes a recitation saved by mistake. A recitation that also holds the day's attendance keeps the
   * attendance and loses only what was recited. Plan progress it already advanced stays.
   */
  async deleteRecitation(teacher: StaffActor, id: string): Promise<void> {
    const row = await this.ownRecitation(teacher, id);
    // A recording this evaluation answered goes back to wait for a new one.
    await this.prisma.recitationRecording.updateMany({ where: { evaluationId: id }, data: { evaluationId: null, reviewedAt: null } });
    if (row.attendanceOn) {
      await this.prisma.evaluation.update({
        where: { id },
        data: { title: 'حضور', surah: null, fromAyah: null, toAyah: null, score: null, comment: null, segmentStatus: null, liveSessionId: null },
      });
    } else {
      await this.prisma.evaluation.delete({ where: { id } });
    }
    await this.audit.record(teacher, 'evaluation.delete', { type: 'student', id: row.studentId }, { surah: row.surah, fromAyah: row.fromAyah, toAyah: row.toAyah });
  }

  private async ownRecitation(teacher: StaffActor, id: string) {
    const row = await this.prisma.evaluation.findFirst({
      where: {
        id,
        teacherId: teacher.id,
        surah: { not: null },
        student: { memberships: { some: { leftAt: null, circle: { teacherId: teacher.id, archivedAt: null } } } },
      },
      select: { studentId: true, attendance: true, attendanceOn: true, score: true, surah: true, fromAyah: true, toAyah: true },
    });
    if (!row) throw notFound();
    return row;
  }

  /** Attendance with nothing recited. It counts towards attendance, and is not a recitation. Saving again corrects the day's record. */
  async recordAttendance(teacher: StaffActor, { studentId, attendance }: AttendanceDto) {
    const { circleId } = await this.memberOrThrow(teacher.id, studentId);
    const row = await this.attendanceUpsert(teacher.id, studentId, circleId, attendance);
    await this.audit.record(teacher, 'attendance.record', { type: 'student', id: studentId }, { attendance });
    await this.notifications.checkAbsence(studentId);
    return toEvaluation(row);
  }

  /** Today's sheet for each of the teacher's circles, with what is already marked. */
  async attendanceSheet(teacher: TeacherRef) {
    const circles = await this.circles(teacher.id);
    const members = await this.prisma.circleMembership.findMany({
      where: { leftAt: null, circleId: { in: circles.map(({ id }) => id) } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { joinedAt: 'asc' }],
      select: { circleId: true, student: { select: { id: true, fullName: true } } },
    });
    const date = riyadhDate();
    const marked = await this.prisma.evaluation.findMany({
      where: { studentId: { in: members.map(({ student }) => student.id) }, attendanceOn: date },
      select: { studentId: true, attendance: true },
    });
    const attendanceOf = new Map(marked.map((row) => [row.studentId, row.attendance]));
    return {
      date,
      circles: circles.map(({ id, name }) => ({
        id,
        name,
        students: members
          .filter(({ circleId }) => circleId === id)
          .map(({ student }) => ({ id: student.id, name: student.fullName, attendance: attendanceOf.get(student.id) ?? null })),
      })),
    };
  }

  /** All or nothing, so a teacher never has to work out which part of a sheet was saved. */
  async saveAttendanceSheet(teacher: StaffActor, { entries }: AttendanceSheetDto): Promise<void> {
    const members = await this.prisma.circleMembership.findMany({
      where: {
        studentId: { in: entries.map(({ studentId }) => studentId) },
        leftAt: null,
        circle: { teacherId: teacher.id, archivedAt: null },
      },
      select: { studentId: true, circleId: true },
    });
    const circleOf = new Map(members.map(({ studentId, circleId }) => [studentId, circleId]));
    if (entries.some(({ studentId }) => !circleOf.has(studentId))) throw notFound();

    await this.prisma.$transaction(
      entries.map(({ studentId, attendance }) => this.attendanceUpsert(teacher.id, studentId, circleOf.get(studentId)!, attendance)),
    );
    await Promise.all(
      entries.map(({ studentId, attendance }) =>
        this.audit.record(teacher, 'attendance.record', { type: 'student', id: studentId }, { attendance }),
      ),
    );
    await Promise.all(entries.map(({ studentId }) => this.notifications.checkAbsence(studentId)));
  }

  async listRecitations(teacher: StaffActor, query: ListRecitationsDto) {
    const where = {
      teacherId: teacher.id,
      surah: { not: null },
      ...(query.studentId ? { studentId: query.studentId } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.evaluation.count({ where }),
      this.prisma.evaluation.findMany({
        where,
        ...pageArgs(query),
        orderBy: { createdAt: 'desc' },
        include: { student: { select: { fullName: true } } },
      }),
    ]);
    return { total, items: items.map((item) => ({ ...toEvaluation(item), studentName: item.student.fullName })) };
  }

  async listTasks(teacher: TeacherRef, query: ListTasksDto) {
    const circles = await this.circles(teacher.id);
    const circleIds = circles.map(({ id }) => id);
    const today = riyadhDate();

    const [tasks, memberCounts] = await Promise.all([
      this.prisma.task.findMany({
        where: { circleId: { in: circleIds }, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        include: {
          student: { select: { id: true, fullName: true } },
          completions: { select: { studentId: true, dueOn: true } },
        },
      }),
      this.prisma.circleMembership.groupBy({ by: ['circleId'], where: { circleId: { in: circleIds }, leftAt: null }, _count: true }),
    ]);
    const circleSize = new Map(memberCounts.map((row) => [row.circleId, row._count]));

    const now = new Date();
    const minutesNow = ((now.getTime() - riyadhDayStart(now).getTime()) / 60_000) | 0;
    const rows = tasks.map((task) => {
      const total = task.studentId ? 1 : (circleSize.get(task.circleId) ?? 0);
      // A daily task counts today's completions only.
      const completed = task.completions.filter(
        ({ dueOn }) => task.recurrence !== 'DAILY' || dueOn.getTime() === today.getTime(),
      ).length;
      const pastDue =
        task.recurrence === 'ONCE'
          ? Boolean(task.dueAt && task.dueAt < now)
          : task.deadlineMinutes !== null && minutesNow > task.deadlineMinutes;
      const status = total > 0 && completed >= total ? 'done' : pastDue ? 'overdue' : 'ongoing';

      return {
        id: task.id,
        title: task.title,
        description: task.description,
        circleId: task.circleId,
        student: task.student && { id: task.student.id, name: task.student.fullName },
        recurrence: task.recurrence,
        dueAt: task.dueAt,
        deadlineMinutes: task.deadlineMinutes,
        completed,
        total,
        status,
        createdAt: task.createdAt,
      };
    });
    return query.status ? rows.filter((row) => row.status === query.status) : rows;
  }

  async createTask(teacher: StaffActor, dto: CreateTaskDto) {
    const circleId = dto.studentId
      ? (await this.memberOrThrow(teacher.id, dto.studentId)).circleId
      : await this.resolveCircle(teacher.id, dto.circleId);

    const task = await this.prisma.task.create({
      data: {
        circleId,
        createdById: teacher.id,
        studentId: dto.studentId ?? null,
        title: dto.title,
        description: dto.description,
        recurrence: dto.recurrence,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        deadlineMinutes: dto.deadlineMinutes ?? null,
      },
      select: { id: true },
    });
    await this.notifications.send(dto.studentId ? [dto.studentId] : await this.notifications.resolve({ type: 'CIRCLE', circleId }), {
      type: 'NEW_TASK',
      title: 'مهمة جديدة',
      body: dto.title,
      dedupeKey: `task:${task.id}`,
    });
    await this.audit.record(teacher, 'task.create', { type: 'task', id: task.id }, dto.studentId ? { studentId: dto.studentId } : {});
    return task;
  }

  /** Archived rather than deleted, so the students' completion history stays. */
  async archiveTask(teacher: StaffActor, taskId: string): Promise<void> {
    const { count } = await this.prisma.task.updateMany({
      where: { id: taskId, archivedAt: null, circle: { teacherId: teacher.id } },
      data: { archivedAt: new Date() },
    });
    if (count !== 1) throw notFound();
  }

  async listSessions(teacher: StaffActor, query: ListSessionsDto) {
    const where = { teacherId: teacher.id, ...(query.kind ? { kind: { in: query.kind } } : {}) };
    const [total, items] = await Promise.all([
      this.prisma.liveSession.count({ where }),
      this.prisma.liveSession.findMany({ where, ...pageArgs(query), orderBy: { scheduledAt: 'desc' }, include: SESSION_INCLUDE }),
    ]);
    return { total, items: items.map(toSession) };
  }

  async getSession(teacher: StaffActor, sessionId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, teacherId: teacher.id },
      include: SESSION_INCLUDE,
    });
    if (!session) throw notFound();
    return toSession(session);
  }

  async createSession(teacher: StaffActor, dto: CreateSessionDto) {
    const scheduledAt = new Date(dto.scheduledAt);
    if (scheduledAt.getTime() < Date.now() - SCHEDULE_GRACE_MS) throw new ApiError(400, 'scheduled_in_past');

    const circleId = dto.studentId
      ? (await this.memberOrThrow(teacher.id, dto.studentId)).circleId
      : await this.resolveCircle(teacher.id, dto.circleId);
    // A student recites in a voice session only on a track that recites online.
    if (dto.kind === 'RECITATION' && dto.studentId) {
      const student = await this.prisma.user.findUnique({
        where: { id: dto.studentId },
        select: { section: true, trackTemplate: { select: { recitationMode: true } } },
      });
      if ((student?.trackTemplate?.recitationMode ?? 'LIVE') !== 'LIVE') throw new ApiError(409, 'track_has_no_live_recitation');
      // Online recitation is for the women's section only.
      if (student?.section === 'MEN') throw new ApiError(409, 'live_recitation_women_only');
    }

    const session = await this.prisma.liveSession.create({
      data: {
        kind: dto.kind,
        title: dto.title,
        scheduledAt,
        circleId,
        teacherId: teacher.id,
        studentId: dto.studentId ?? null,
        entryMode: dto.kind === 'ISMA' ? (dto.entryMode ?? 'OPEN') : null,
      },
      include: SESSION_INCLUDE,
    });
    return toSession(session);
  }

  async startSession(teacher: StaffActor, id: string) {
    await this.moveSession(teacher, id, 'SCHEDULED', { status: 'IN_PROGRESS', startedAt: new Date() });
    const session = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id },
      select: { id: true, title: true, studentId: true, circleId: true, kind: true },
    });
    // An isma session tells each student her own place in the queue instead.
    if (session.kind === 'ISMA' && session.circleId) await this.isma.openQueue(session.id, session.circleId, session.title);
    else await this.notifications.sessionStarted(session);
    return this.getSession(teacher, id);
  }

  async endSession(teacher: StaffActor, id: string) {
    const session = await this.moveSession(teacher, id, 'IN_PROGRESS', { status: 'COMPLETED', endedAt: new Date() });
    this.voice.endRoom(id);
    // A recitation heard in a voice session finishes the wird's session step, where the track counts attending.
    const ended = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id },
      select: { kind: true, studentId: true, circleId: true, startedAt: true },
    });
    if (ended.kind === 'RECITATION' && ended.studentId) await this.plans.markSessionStep(ended.studentId, { kind: 'ENDED' });
    if (ended.kind === 'ISMA' && ended.circleId) {
      const { unmarkedPresent, recited } = await this.isma.close(id);
      const day = riyadhDate(ended.startedAt ?? new Date());
      // Whoever came in and was never marked, was there.
      for (const studentId of unmarkedPresent) {
        await this.markAttendance(teacher, studentId, ended.circleId, 'PRESENT', day);
      }
      await this.prisma.ismaTurn.updateMany({ where: { sessionId: id, studentId: { in: unmarkedPresent } }, data: { attendance: 'PRESENT' } });
      for (const studentId of recited) await this.plans.markSessionStep(studentId, { kind: 'ENDED' });
    }
    return session;
  }

  cancelSession(teacher: StaffActor, id: string) {
    return this.moveSession(teacher, id, 'SCHEDULED', { status: 'CANCELLED' });
  }

  async evaluateSession(teacher: StaffActor, sessionId: string, dto: EvaluateSessionDto) {
    const session = await this.prisma.liveSession.findFirst({ where: { id: sessionId, teacherId: teacher.id } });
    if (!session) throw notFound();
    if (session.kind !== 'RECITATION' || session.status !== 'COMPLETED' || !session.studentId) {
      throw new ApiError(409, 'invalid_session_state');
    }
    const { circleId } = await this.memberOrThrow(teacher.id, session.studentId);

    try {
      // The attendance belongs to the day the session took place, even when it is evaluated later.
      const evaluation = await this.saveEvaluation(teacher, session.studentId, circleId, dto, {
        liveSessionId: session.id,
        day: riyadhDate(session.startedAt ?? session.scheduledAt),
      });
      await this.prisma.liveSession.update({ where: { id: session.id }, data: { attendance: dto.attendance } });
      return toEvaluation(evaluation);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'already_evaluated');
      throw error;
    }
  }

  async saveSessionNotes(teacher: StaffActor, sessionId: string, notes: string) {
    const { count } = await this.prisma.liveSession.updateMany({
      where: { id: sessionId, teacherId: teacher.id, kind: 'CORRECTION', status: 'COMPLETED' },
      data: { notes },
    });
    if (count !== 1) {
      await this.getSession(teacher, sessionId);
      throw new ApiError(409, 'invalid_session_state');
    }
    await this.audit.record(teacher, 'session.notes', { type: 'session', id: sessionId });
    return this.getSession(teacher, sessionId);
  }

  /** Plan-based columns such as completion wait for the curriculum. These come from what was actually recorded. */
  async report(teacher: StaffActor, { period }: ReportQueryDto) {
    const since = new Date(Date.now() - (period === 'week' ? 7 : 30) * DAY_MS);
    const members = await this.prisma.circleMembership.findMany({
      where: { leftAt: null, circle: { teacherId: teacher.id, archivedAt: null } },
      select: { student: { select: { id: true, fullName: true, trackTemplate: { select: { name: true } } } } },
    });
    const ids = members.map(({ student }) => student.id);
    const [attendance, scores] = await Promise.all([
      this.prisma.evaluation.groupBy({
        by: ['studentId', 'attendance'],
        where: { studentId: { in: ids }, createdAt: { gte: since }, ...ATTENDANCE_DAY },
        _count: true,
      }),
      this.prisma.evaluation.groupBy({
        by: ['studentId'],
        where: { studentId: { in: ids }, createdAt: { gte: since }, score: { not: null } },
        _avg: { score: true },
        _count: true,
      }),
    ]);
    const scoreBy = new Map(scores.map((row) => [row.studentId, row]));
    const summaries = await this.plans.summaries(ids);

    return {
      period,
      rows: members.map(({ student }) => {
        const score = scoreBy.get(student.id);
        const average = score?._avg.score;
        return {
          studentId: student.id,
          name: student.fullName,
          track: student.trackTemplate?.name ?? null,
          attendanceRate: attendanceRate(countsFor(attendance, student.id)),
          averageScore: average ? Math.round(Number(average) * 10) / 10 : null,
          recitations: score?._count ?? 0,
          completion: summaries.get(student.id)?.commitment ?? null,
          delay: summaries.get(student.id)?.delay ?? null,
          nextGate: findSurah(summaries.get(student.id)?.currentSurah ?? 0)?.name ?? null,
          passedGates: summaries.get(student.id)?.passedSurahs ?? 0,
        };
      }),
    };
  }

  async listIncomingTransfers(teacher: StaffActor) {
    const items = await this.prisma.transferRequest.findMany({
      where: { status: 'PENDING_TEACHER', toCircle: { teacherId: teacher.id } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        // The student's name and track only: the record opens once the teacher accepts.
        student: { select: { fullName: true, trackTemplate: { select: { name: true } } } },
        fromCircle: { select: { name: true } },
        toCircle: { select: { id: true, name: true } },
      },
    });
    return items.map((item) => ({
      id: item.id,
      studentName: item.student.fullName,
      track: item.student.trackTemplate?.name ?? null,
      fromCircleName: item.fromCircle?.name ?? null,
      toCircle: item.toCircle,
      createdAt: item.createdAt,
    }));
  }

  /** The last step of a transfer: the student leaves the old circle and joins this one, all at once. */
  async acceptTransfer(teacher: StaffActor, transferId: string): Promise<void> {
    const transfer = await this.incomingTransfer(teacher, transferId);
    await this.prisma.$transaction(async (tx) => {
      // Serializes joins to this circle, so two at once can't pass the capacity check together.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${transfer.toCircleId}::text, 0))::text`;

      const circle = await tx.circle.findUniqueOrThrow({ where: { id: transfer.toCircleId }, select: { capacity: true } });
      const size = await tx.circleMembership.count({ where: { circleId: transfer.toCircleId, leftAt: null } });
      if (size >= circle.capacity) throw new ApiError(409, 'circle_full');

      const moved = await tx.transferRequest.updateMany({
        where: { id: transfer.id, status: 'PENDING_TEACHER' },
        data: { status: 'COMPLETED' },
      });
      if (moved.count !== 1) throw new ApiError(409, 'invalid_transfer_state');

      await tx.circleMembership.updateMany({ where: { studentId: transfer.studentId, leftAt: null }, data: { leftAt: new Date() } });
      await tx.circleMembership.create({ data: { studentId: transfer.studentId, circleId: transfer.toCircleId } });
    });
    await this.audit.record(teacher, 'transfer.accept', { type: 'transfer', id: transfer.id }, { studentId: transfer.studentId });
    await this.notifications.transferDecided(transfer.id, true);
  }

  async rejectTransfer(teacher: StaffActor, transferId: string): Promise<void> {
    const transfer = await this.incomingTransfer(teacher, transferId);
    const { count } = await this.prisma.transferRequest.updateMany({
      where: { id: transfer.id, status: 'PENDING_TEACHER' },
      data: { status: 'REJECTED' },
    });
    if (count !== 1) throw new ApiError(409, 'invalid_transfer_state');
    await this.audit.record(teacher, 'transfer.reject', { type: 'transfer', id: transfer.id }, { studentId: transfer.studentId });
    await this.notifications.transferDecided(transfer.id, false);
  }

  private async incomingTransfer(teacher: StaffActor, transferId: string) {
    const transfer = await this.prisma.transferRequest.findFirst({
      where: { id: transferId, status: 'PENDING_TEACHER', toCircle: { teacherId: teacher.id } },
      select: { id: true, studentId: true, toCircleId: true },
    });
    if (!transfer) throw notFound();
    return transfer;
  }

  /** Students whose last three attendance days are all absences. Each student's own three, however many records the others have. */
  private async repeatedlyAbsent(studentIds: string[]): Promise<Set<string>> {
    if (studentIds.length === 0) return new Set();
    const students = await this.prisma.user.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        evaluationsGot: { where: ATTENDANCE_DAY, orderBy: { attendanceOn: 'desc' }, take: 3, select: { attendance: true } },
      },
    });
    return new Set(
      students
        .filter(({ evaluationsGot: days }) => days.length === 3 && days.every(({ attendance }) => attendance === 'ABSENT'))
        .map(({ id }) => id),
    );
  }

  /** The day's attendance of one student, from inside a session. It shows on the attendance sheet at once. */
  async markAttendance(teacher: StaffActor, studentId: string, circleId: string, attendance: AttendanceStatus, day: Date): Promise<void> {
    await this.attendanceUpsert(teacher.id, studentId, circleId, attendance, day);
    await this.audit.record(teacher, 'attendance.record', { type: 'student', id: studentId }, { attendance });
    await this.notifications.checkAbsence(studentId);
  }

  /** The date in the key keeps one record per student per day, however many times it is saved. A later record of the day replaces it. */
  private attendanceUpsert(teacherId: string, studentId: string, circleId: string, attendance: AttendanceStatus, attendanceOn = riyadhDate()) {
    return this.prisma.evaluation.upsert({
      where: { studentId_attendanceOn: { studentId, attendanceOn } },
      create: { studentId, teacherId, circleId, title: 'حضور', attendance, attendanceOn },
      update: { teacherId, circleId, attendance },
    });
  }

  private circles(teacherId: string) {
    return this.prisma.circle.findMany({
      where: { teacherId, archivedAt: null },
      select: { id: true, name: true, capacity: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async resolveCircle(teacherId: string, circleId?: string): Promise<string> {
    const circles = await this.circles(teacherId);
    if (circleId) {
      if (!circles.some(({ id }) => id === circleId)) throw notFound();
      return circleId;
    }
    if (circles.length !== 1) throw new ApiError(400, 'circle_required');
    return circles[0].id;
  }

  private async memberOrThrow(teacherId: string, studentId: string) {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null, circle: { teacherId, archivedAt: null } },
      select: { circleId: true, joinedAt: true, circle: { select: { id: true, name: true } } },
    });
    if (!membership) throw notFound();
    return membership;
  }

  /**
   * Saves a recitation's evaluation. Callers check access first. A null attendance is for a recording the student
   * sent from the app: it was heard later, so it says nothing about the day's attendance.
   */
  async saveEvaluation(
    teacher: StaffActor,
    studentId: string,
    circleId: string,
    dto: EvaluationInput,
    {
      liveSessionId,
      day = riyadhDate(),
      fromRecording = false,
    }: { liveSessionId?: string; day?: Date; fromRecording?: boolean } = {},
  ) {
    const surah = findSurah(dto.surah);
    if (!surah || dto.toAyah > surah.ayahCount) throw new ApiError(400, 'ayah_out_of_range');

    // The recitation, and the day's attendance it implies, together. Attendance is counted from the day's
    // record alone, so a recitation and the attendance sheet on the same day count once.
    const attendance = dto.attendance;
    const [evaluation] = await this.prisma.$transaction([
      this.prisma.evaluation.create({
        data: {
          studentId,
          teacherId: teacher.id,
          circleId,
          liveSessionId,
          title: `${surah.name} · ${dto.fromAyah}-${dto.toAyah}`,
          surah: dto.surah,
          fromAyah: dto.fromAyah,
          toAyah: dto.toAyah,
          score: dto.score,
          comment: dto.note || null,
          segmentStatus: dto.segmentStatus,
          attendance,
        },
      }),
      ...(attendance ? [this.attendanceUpsert(teacher.id, studentId, circleId, attendance, day)] : []),
    ]);
    await this.audit.record(
      teacher,
      'evaluation.create',
      { type: 'student', id: studentId },
      { surah: dto.surah, fromAyah: dto.fromAyah, toAyah: dto.toAyah, score: dto.score, attendance: dto.attendance, hasNote: Boolean(dto.note) },
    );
    if (dto.attendance !== 'ABSENT') {
      await this.notifications.send([studentId], {
        type: 'EVALUATION',
        title: 'تقييم جديد من {{معلمك|معلمتك}}',
        body: dto.note ? `${evaluation.title}: ${dto.note}` : evaluation.title,
        dedupeKey: `evaluation:${evaluation.id}`,
      });
    }
    if (attendance) await this.notifications.checkAbsence(studentId);
    // Before the plan can move on, so the step lands on the portion that was recited.
    if (dto.attendance !== 'ABSENT') {
      await this.plans.markSessionStep(studentId, {
        kind: 'EVALUATED',
        mastered: dto.segmentStatus === 'MASTERED',
        via: fromRecording ? 'RECORDING' : liveSessionId ? 'SESSION' : 'DIRECT',
      });
    }
    if (dto.attendance !== 'ABSENT' && dto.segmentStatus === 'MASTERED') {
      await this.plans.advanceFromEvaluation(studentId, dto.surah, dto.fromAyah, dto.toAyah);
    }
    return evaluation;
  }

  private async moveSession(
    teacher: StaffActor,
    sessionId: string,
    from: 'SCHEDULED' | 'IN_PROGRESS',
    data: { status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; startedAt?: Date; endedAt?: Date },
  ) {
    // The status in the condition means two simultaneous requests can't both make the same move.
    const { count } = await this.prisma.liveSession.updateMany({
      where: { id: sessionId, teacherId: teacher.id, status: from },
      data,
    });
    if (count !== 1) {
      await this.getSession(teacher, sessionId);
      throw new ApiError(409, 'invalid_session_state');
    }
    return this.getSession(teacher, sessionId);
  }
}

const SESSION_INCLUDE = {
  student: { select: { id: true, fullName: true } },
  circle: { select: { id: true, name: true } },
  evaluations: { select: { id: true } },
} as const;

type SessionRow = {
  id: string;
  kind: 'RECITATION' | 'CORRECTION' | 'ISMA';
  title: string;
  notes: string | null;
  scheduledAt: Date;
  status: string;
  attendance: AttendanceStatus | null;
  circleId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  student: { id: string; fullName: string } | null;
  circle: { id: string; name: string } | null;
  entryMode: 'OPEN' | 'TURN' | null;
  evaluations: { id: string }[];
};

function toSession(session: SessionRow) {
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    notes: session.notes,
    scheduledAt: session.scheduledAt,
    status: session.status,
    attendance: session.attendance,
    circleId: session.circleId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    /** Null means the whole circle. */
    student: session.student && { id: session.student.id, name: session.student.fullName },
    evaluated: session.evaluations.length > 0,
    circle: session.circle,
    /** An isma session's: who may be in the room. */
    entryMode: session.entryMode,
  };
}

type EvaluationRow = {
  id: string;
  studentId: string;
  title: string;
  surah: number | null;
  fromAyah: number | null;
  toAyah: number | null;
  score: { toString(): string } | null;
  maxScore: { toString(): string };
  comment: string | null;
  segmentStatus: string | null;
  attendance: AttendanceStatus | null;
  liveSessionId: string | null;
  createdAt: Date;
};

function toEvaluation(row: EvaluationRow) {
  return {
    id: row.id,
    studentId: row.studentId,
    title: row.title,
    surah: row.surah,
    fromAyah: row.fromAyah,
    toAyah: row.toAyah,
    score: row.score === null ? null : Number(row.score),
    maxScore: Number(row.maxScore),
    note: row.comment,
    segmentStatus: row.segmentStatus,
    attendance: row.attendance,
    sessionId: row.liveSessionId,
    createdAt: row.createdAt,
  };
}

/** What the teacher's lists show about a student's plan. */
function planFields(summary: PlanSummary | undefined, repeatedlyAbsent: boolean) {
  return {
    status: repeatedlyAbsent ? ('absent' as const) : (summary?.status ?? ('no_plan' as const)),
    progress: summary?.status === 'no_plan' ? null : (summary?.progress ?? null),
    commitment: summary?.commitment ?? null,
    delay: summary?.delay ?? null,
    wird: summary?.nextLabel ?? null,
    passedSurahs: summary?.passedSurahs ?? 0,
    nextGate: findSurah(summary?.currentSurah ?? 0)?.name ?? null,
  };
}

function countsFor(rows: { studentId: string; attendance: AttendanceStatus | null; _count: number }[], studentId: string) {
  const counts: Partial<Record<AttendanceStatus, number>> = {};
  for (const row of rows) {
    if (row.studentId === studentId && row.attendance) counts[row.attendance] = row._count;
  }
  return counts;
}

