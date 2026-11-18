import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { ATTENDANCE_DAY, attendanceRate, isUniqueViolation } from '../common/staff-api.js';
import { assertTeacherFitsCircle } from '../common/sections.js';
import { findSurah } from '../common/surahs.js';
import type { AttendanceStatus } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanService } from '../program/plan.service.js';
import { SettingsService } from '../program/settings.service.js';
import { TeacherProgramService } from '../teacher/teacher-program.service.js';
import { TeacherService } from '../teacher/teacher.service.js';
import { assertOpenTrack, assertStudentFitsCircle } from './circle-track.js';
import type {
  CreateAnnouncementDto,
  CreateCircleDto,
  RequestTransferDto,
  UpdateCircleDto,
  UpdateTeacherDto,
} from './supervisor.schemas.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_LIMIT = 50;
const OPEN_TRANSFER = ['PENDING_ADMIN', 'PENDING_TEACHER'] as const;

const ACTIVITY_KIND: Record<string, string> = {
  'evaluation.create': 'recitation',
  'task.create': 'task',
  'transfer.accept': 'transfer',
  'transfer.reject': 'transfer',
  'gate.approve': 'gate',
  'gate.return': 'gate',
  'attendance.record': 'attendance',
  'session.notes': 'note',
};

// Everything here is limited to the supervisor's scope. A record outside it answers as if it didn't exist.
const notFound = () => new ApiError(404, 'not_found');

@Injectable()
export class SupervisorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plans: PlanService,
    private readonly teachers: TeacherService,
    private readonly teacherProgram: TeacherProgramService,
    private readonly settings: SettingsService,
  ) {}

  home(staff: StaffActor) {
    return this.scopeOverview(this.scopeOf(staff));
  }

  /** A scope's figures and circles. The administration reads the same view of a supervisor. */
  async scopeOverview(scopeId: string) {
    const [scope, circles, teachers] = await Promise.all([
      this.prisma.scope.findUniqueOrThrow({ where: { id: scopeId }, select: { id: true, name: true } }),
      this.circleRows(scopeId),
      this.prisma.user.count({ where: { role: 'TEACHER', scopeId, status: 'ACTIVE' } }),
    ]);

    const totals: Partial<Record<AttendanceStatus, number>> = {};
    for (const circle of circles) {
      for (const [key, value] of Object.entries(circle.attendanceCounts)) {
        const status = key as AttendanceStatus;
        totals[status] = (totals[status] ?? 0) + value;
      }
    }

    return {
      scope,
      stats: {
        circles: circles.length,
        teachers,
        students: circles.reduce((sum, circle) => sum + circle.students, 0),
        weeklyAttendance: attendanceRate(totals),
        weeklyRecitations: circles.reduce((sum, circle) => sum + circle.weeklyRecitations, 0),
        commitment: average(circles.map((circle) => circle.commitment)),
      },
      circles: circles.map(publicCircle),
    };
  }

  async listCircles(staff: StaffActor) {
    return (await this.circleRows(this.scopeOf(staff))).map(publicCircle);
  }

  async createCircle(staff: StaffActor, dto: CreateCircleDto) {
    const scopeId = this.scopeOf(staff);
    await this.assertAvailableTeacher(scopeId, dto.teacherId);
    await assertOpenTrack(this.prisma, dto.trackId);
    const circle = await this.prisma.circle.create({
      data: { name: dto.name, teacherId: dto.teacherId, scopeId, capacity: dto.capacity, trackTemplateId: dto.trackId },
      select: { id: true },
    });
    await this.audit.record(staff, 'circle.create', { type: 'circle', id: circle.id }, { teacherId: dto.teacherId, trackId: dto.trackId });
    return circle;
  }

  async updateCircle(staff: StaffActor, circleId: string, dto: UpdateCircleDto) {
    const scopeId = this.scopeOf(staff);
    const circle = await this.circleInScope(scopeId, circleId);

    const teacherChanged = dto.teacherId !== undefined && dto.teacherId !== circle.teacherId;
    if (dto.teacherId && teacherChanged) {
      await this.assertAvailableTeacher(scopeId, dto.teacherId);
      await assertTeacherFitsCircle(this.prisma, circleId, dto.teacherId);
    }
    if (dto.capacity !== undefined) {
      const size = await this.prisma.circleMembership.count({ where: { circleId, leftAt: null } });
      if (dto.capacity < size) throw new ApiError(409, 'capacity_below_students');
    }
    await this.prisma.$transaction([
      this.prisma.circle.update({ where: { id: circleId }, data: dto }),
      // The previous teacher can no longer reach these students, so her upcoming sessions can't take place.
      ...(teacherChanged && circle.teacherId
        ? [this.prisma.liveSession.updateMany({ where: { circleId, teacherId: circle.teacherId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } })]
        : []),
    ]);
    await this.audit.record(staff, 'circle.update', { type: 'circle', id: circleId }, { ...dto });
  }

  async archiveCircle(staff: StaffActor, circleId: string): Promise<void> {
    await this.circleInScope(this.scopeOf(staff), circleId);
    await this.archiveEmptyCircle(staff, circleId);
  }

  /** Callers check access first. What was waiting on the circle ends with it, so no student can join it later. */
  async archiveEmptyCircle(actor: StaffActor, circleId: string): Promise<void> {
    const size = await this.prisma.circleMembership.count({ where: { circleId, leftAt: null } });
    if (size > 0) throw new ApiError(409, 'circle_not_empty');
    await this.prisma.$transaction([
      this.prisma.circle.update({ where: { id: circleId }, data: { archivedAt: new Date() } }),
      this.prisma.transferRequest.updateMany({ where: { toCircleId: circleId, status: { in: [...OPEN_TRANSFER] } }, data: { status: 'CANCELLED' } }),
      this.prisma.liveSession.updateMany({ where: { circleId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } }),
    ]);
    await this.audit.record(actor, 'circle.archive', { type: 'circle', id: circleId });
  }

  async listTeachers(staff: StaffActor) {
    const teachers = await this.prisma.user.findMany({
      where: { role: 'TEACHER', scopeId: this.scopeOf(staff) },
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        phone: true,
        status: true,
        taughtCircles: { where: { archivedAt: null }, select: { id: true, name: true } },
      },
    });
    return teachers.map((teacher) => ({
      id: teacher.id,
      name: teacher.fullName,
      phone: teacher.phone,
      status: teacher.status,
      circles: teacher.taughtCircles,
      available: teacher.status === 'ACTIVE' && teacher.taughtCircles.length === 0,
    }));
  }

  async teacherDetail(staff: StaffActor, teacherId: string) {
    const teacher = await this.prisma.user.findFirst({
      where: { id: teacherId, role: 'TEACHER', scopeId: this.scopeOf(staff) },
      select: { id: true, fullName: true, email: true, phone: true, status: true },
    });
    if (!teacher) throw notFound();
    const { fullName, ...account } = teacher;
    return { account: { ...account, name: fullName }, ...(await this.teacherOverview(teacherId)) };
  }

  /** A teacher's figures, circle and students. The administration reads the same view of a teacher. */
  async teacherOverview(teacherId: string) {
    const [home, roster, circles] = await Promise.all([
      this.teachers.home({ id: teacherId }),
      // A circle holds at most 200 students, and a teacher has one circle.
      this.teachers.listStudents({ id: teacherId }, { page: 1, limit: 200 }),
      this.prisma.circle.findMany({
        where: { teacherId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          capacity: true,
          scope: { select: { id: true, name: true } },
          trackTemplate: { select: { id: true, name: true } },
          _count: { select: { memberships: { where: { leftAt: null } } } },
        },
      }),
    ]);
    return {
      stats: home.stats,
      nextSession: home.nextSession,
      circles: circles.map(({ _count, trackTemplate, ...circle }) => ({ ...circle, track: trackTemplate, students: _count.memberships })),
      students: roster.items,
    };
  }

  /**
   * A student in one of the scope's circles: plan, attendance, recitations and record, as the teacher sees them.
   * With the record closed, what was recorded in other circles stays out, as it does for the teacher.
   */
  async studentFile(staff: StaffActor, studentId: string) {
    const membership = await this.memberInScope(staff, studentId);
    const { openRecord } = await this.settings.get('permissions');
    const { teacher, ...circle } = membership.circle;
    return {
      ...(await this.teachers.studentFile(studentId, openRecord ? null : membership.circleId)),
      circle: { ...circle, teacher: teacher && { id: teacher.id, name: teacher.fullName } },
      joinedAt: membership.joinedAt,
    };
  }

  /** The parts of the file the summary leaves out: what was memorized, recitations, exams, attendance and tasks. */
  async studentRecord(staff: StaffActor, studentId: string) {
    const membership = await this.memberInScope(staff, studentId);
    const { openRecord } = await this.settings.get('permissions');
    return this.teacherProgram.recordOf(studentId, membership.circleId, !openRecord);
  }

  private async memberInScope(staff: StaffActor, studentId: string) {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null, circle: { scopeId: this.scopeOf(staff), archivedAt: null } },
      select: { circleId: true, joinedAt: true, circle: { select: { id: true, name: true, teacher: { select: { id: true, fullName: true } } } } },
    });
    if (!membership) throw notFound();
    return membership;
  }

  async updateTeacher(staff: StaffActor, teacherId: string, dto: UpdateTeacherDto): Promise<void> {
    try {
      const { count } = await this.prisma.user.updateMany({
        where: { id: teacherId, role: 'TEACHER', scopeId: this.scopeOf(staff) },
        data: dto,
      });
      if (count !== 1) throw notFound();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'identity_taken');
      throw error;
    }
    // Which contact details changed, not their values.
    await this.audit.record(staff, 'staff.update', { type: 'user', id: teacherId }, { phoneChanged: dto.phone !== undefined });
  }

  async teacherActivity(staff: StaffActor, teacherId: string) {
    const teacher = await this.prisma.user.findFirst({
      where: { id: teacherId, role: 'TEACHER', scopeId: this.scopeOf(staff) },
      select: { id: true },
    });
    if (!teacher) throw notFound();

    const logs = await this.prisma.auditLog.findMany({
      where: { actorId: teacherId, action: { in: Object.keys(ACTIVITY_KIND) } },
      orderBy: { createdAt: 'desc' },
      take: ACTIVITY_LIMIT,
    });

    // Names are looked up now rather than stored in the log, so a deleted student's name is gone from it too.
    const metadataOf = (metadata: unknown) => (metadata ?? {}) as Record<string, unknown>;
    const studentIdOf = (log: (typeof logs)[number]) =>
      log.targetType === 'student' ? log.targetId : (metadataOf(log.metadata).studentId as string | undefined);
    const ids = logs.map(studentIdOf).filter((id): id is string => Boolean(id));
    const students = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    const names = new Map(students.map((student) => [student.id, student.fullName]));

    return logs.map((log) => {
      const metadata = metadataOf(log.metadata);
      const studentId = studentIdOf(log);
      const surah = typeof metadata.surah === 'number' ? findSurah(metadata.surah) : undefined;
      return {
        kind: metadata.attendance === 'ABSENT' ? 'attendance' : metadata.hasNote === true ? 'note' : ACTIVITY_KIND[log.action],
        action: log.action,
        studentName: studentId ? (names.get(studentId) ?? null) : null,
        surahName: surah?.name ?? null,
        fromAyah: metadata.fromAyah ?? null,
        toAyah: metadata.toAyah ?? null,
        score: metadata.score ?? null,
        createdAt: log.createdAt,
      };
    });
  }

  async distribution(staff: StaffActor) {
    const scopeId = this.scopeOf(staff);
    const [circles, unassigned, transfers] = await Promise.all([
      this.prisma.circle.findMany({
        where: { scopeId, archivedAt: null },
        orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          capacity: true,
          teacher: { select: { fullName: true } },
          trackTemplate: { select: { id: true, name: true } },
          memberships: {
            where: { leftAt: null },
            orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { joinedAt: 'asc' }],
            select: { student: { select: { id: true, fullName: true, trackTemplate: { select: { id: true, name: true } } } } },
          },
        },
      }),
      // Name and track only: enough to place a student, and no contact details. All of them, because the board counts who waits on each track from this list.
      this.prisma.user.findMany({
        where: {
          role: 'STUDENT',
          status: 'ACTIVE',
          admissionStatus: 'ACCEPTED',
          memberships: { none: { leftAt: null } },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fullName: true, trackTemplate: { select: { id: true, name: true } } },
      }),
      this.prisma.transferRequest.findMany({
        where: { status: { in: [...OPEN_TRANSFER] }, toCircle: { scopeId } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
          student: { select: { id: true, fullName: true } },
          fromCircleId: true,
          toCircleId: true,
        },
      }),
    ]);

    const toStudent = (student: { id: string; fullName: string; trackTemplate: { id: string; name: string } | null }) => ({
      id: student.id,
      name: student.fullName,
      track: student.trackTemplate?.name ?? null,
      trackId: student.trackTemplate?.id ?? null,
    });

    return {
      circles: circles.map((circle) => ({
        id: circle.id,
        name: circle.name,
        capacity: circle.capacity,
        teacherName: circle.teacher?.fullName ?? null,
        track: circle.trackTemplate,
        students: circle.memberships.map(({ student }) => toStudent(student)),
      })),
      unassigned: unassigned.map(toStudent),
      transfers: transfers.map((transfer) => ({
        id: transfer.id,
        status: transfer.status,
        createdAt: transfer.createdAt,
        student: { id: transfer.student.id, name: transfer.student.fullName },
        fromCircleId: transfer.fromCircleId,
        toCircleId: transfer.toCircleId,
      })),
    };
  }

  async assignStudent(staff: StaffActor, circleId: string, studentId: string): Promise<void> {
    await this.circleInScope(this.scopeOf(staff), circleId);
    await this.enrollStudent(staff, circleId, studentId);
  }

  /** Callers check access to the circle first. */
  async enrollStudent(actor: StaffActor, circleId: string, studentId: string): Promise<void> {
    const student = await this.prisma.user.findFirst({ where: { id: studentId, role: 'STUDENT', status: 'ACTIVE' }, select: { admissionStatus: true } });
    if (!student) throw notFound();
    if (student.admissionStatus !== 'ACCEPTED') throw new ApiError(409, 'student_not_admitted');
    await assertStudentFitsCircle(this.prisma, circleId, studentId);

    try {
      await this.prisma.$transaction(async (tx) => {
        // Serializes joins to this circle, so two at once can't pass the capacity check together.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${circleId}::text, 0))::text`;
        const circle = await tx.circle.findUniqueOrThrow({ where: { id: circleId }, select: { capacity: true } });
        const size = await tx.circleMembership.count({ where: { circleId, leftAt: null } });
        if (size >= circle.capacity) throw new ApiError(409, 'circle_full');
        await tx.circleMembership.create({ data: { studentId, circleId } });
      });
    } catch (error) {
      // The database allows one current circle per student, whatever arrives at the same moment.
      if (isUniqueViolation(error)) throw new ApiError(409, 'already_assigned');
      throw error;
    }
    // Joining a circle is when the student's plan begins.
    await this.plans.startPlan(studentId);
    await this.audit.record(actor, 'student.assign', { type: 'student', id: studentId }, { circleId });
  }

  async removeStudent(staff: StaffActor, circleId: string, studentId: string): Promise<void> {
    await this.circleInScope(this.scopeOf(staff), circleId);
    await this.removeFromCircle(staff, circleId, studentId);
  }

  /** Callers check access to the circle first. The student returns to awaiting assignment. Her plan and record stay, so she continues where she was. */
  async removeFromCircle(actor: StaffActor, circleId: string, studentId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const left = await tx.circleMembership.updateMany({ where: { circleId, studentId, leftAt: null }, data: { leftAt: new Date() } });
      // Thrown here so a stale page, or a student from another circle, cancels nothing.
      if (left.count !== 1) throw notFound();
      await tx.transferRequest.updateMany({ where: { studentId, status: { in: [...OPEN_TRANSFER] } }, data: { status: 'CANCELLED' } });
      await tx.liveSession.updateMany({ where: { circleId, studentId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
    });
    await this.audit.record(actor, 'student.remove_from_circle', { type: 'student', id: studentId }, { circleId });
  }

  async reorderCircles(staff: StaffActor, circleIds: string[]): Promise<void> {
    const scopeId = this.scopeOf(staff);
    const circles = await this.prisma.circle.findMany({ where: { scopeId, archivedAt: null }, select: { id: true, position: true } });
    const changes = placeChanges(circles, circleIds);
    await this.prisma.$transaction(changes.map(({ id, position }) => this.prisma.circle.update({ where: { id }, data: { position } })));
    await this.audit.record(staff, 'circle.reorder', { type: 'scope', id: scopeId });
  }

  async reorderStudents(staff: StaffActor, circleId: string, studentIds: string[]): Promise<void> {
    await this.circleInScope(this.scopeOf(staff), circleId);
    const members = await this.prisma.circleMembership.findMany({ where: { circleId, leftAt: null }, select: { studentId: true, position: true } });
    const changes = placeChanges(members.map(({ studentId, position }) => ({ id: studentId, position })), studentIds);
    await this.prisma.$transaction(
      changes.map(({ id, position }) => this.prisma.circleMembership.updateMany({ where: { circleId, studentId: id, leftAt: null }, data: { position } })),
    );
    await this.audit.record(staff, 'circle.reorder_students', { type: 'circle', id: circleId });
  }

  async requestTransfer(staff: StaffActor, { studentId, toCircleId }: RequestTransferDto) {
    const scopeId = this.scopeOf(staff);
    const target = await this.circleInScope(scopeId, toCircleId);
    if (!target.teacherId) throw new ApiError(409, 'circle_has_no_teacher');
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null, circle: { scopeId } },
      select: { circleId: true },
    });
    if (!membership) throw notFound();
    if (membership.circleId === toCircleId) throw new ApiError(409, 'already_in_circle');
    await assertStudentFitsCircle(this.prisma, toCircleId, studentId);

    try {
      const transfer = await this.prisma.transferRequest.create({
        data: { studentId, fromCircleId: membership.circleId, toCircleId, requestedById: staff.id },
        select: { id: true, status: true },
      });
      await this.audit.record(staff, 'transfer.request', { type: 'transfer', id: transfer.id }, { studentId, toCircleId });
      return transfer;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'transfer_in_progress');
      throw error;
    }
  }

  async cancelTransfer(staff: StaffActor, transferId: string): Promise<void> {
    const { count } = await this.prisma.transferRequest.updateMany({
      where: { id: transferId, status: { in: [...OPEN_TRANSFER] }, toCircle: { scopeId: this.scopeOf(staff) } },
      data: { status: 'CANCELLED' },
    });
    if (count !== 1) throw notFound();
    await this.audit.record(staff, 'transfer.cancel', { type: 'transfer', id: transferId });
  }

  async listAnnouncements(staff: StaffActor) {
    const scopeId = this.scopeOf(staff);
    return this.prisma.announcement.findMany({
      where: { OR: [{ scopeId }, { circle: { scopeId } }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, scope: true, circleId: true, title: true, body: true, publishedAt: true },
    });
  }

  async createAnnouncement(staff: StaffActor, dto: CreateAnnouncementDto) {
    const scopeId = this.scopeOf(staff);
    if (dto.circleId) await this.circleInScope(scopeId, dto.circleId);
    const announcement = await this.prisma.announcement.create({
      data: {
        scope: dto.audience,
        scopeId: dto.audience === 'SCOPE' ? scopeId : null,
        circleId: dto.circleId ?? null,
        authorId: staff.id,
        title: dto.title,
        body: dto.body,
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    await this.audit.record(staff, 'announcement.create', { type: 'announcement', id: announcement.id });
    return announcement;
  }

  /** A supervisor with no scope has nothing to see, so nothing can leak if an admin forgets to set one. */
  private scopeOf(staff: StaffActor): string {
    if (!staff.scopeId) throw new ApiError(403, 'no_scope');
    return staff.scopeId;
  }

  private async circleInScope(scopeId: string, circleId: string) {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, scopeId, archivedAt: null },
      select: { id: true, teacherId: true },
    });
    if (!circle) throw notFound();
    return circle;
  }

  async assertAvailableTeacher(scopeId: string, teacherId: string): Promise<void> {
    const teacher = await this.prisma.user.findFirst({
      where: { id: teacherId, role: 'TEACHER', scopeId, status: 'ACTIVE' },
      select: { taughtCircles: { where: { archivedAt: null }, select: { id: true } } },
    });
    if (!teacher) throw notFound();
    if (teacher.taughtCircles.length > 0) throw new ApiError(409, 'teacher_busy');
  }

  private async circleRows(scopeId: string) {
    const circles = await this.prisma.circle.findMany({
      where: { scopeId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        capacity: true,
        teacher: { select: { id: true, fullName: true } },
        trackTemplate: { select: { id: true, name: true } },
      },
    });
    const ids = circles.map(({ id }) => id);
    const since = new Date(Date.now() - WEEK_MS);
    const [memberRows, attendance, recitations] = await Promise.all([
      this.prisma.circleMembership.findMany({ where: { circleId: { in: ids }, leftAt: null }, select: { circleId: true, studentId: true } }),
      this.prisma.evaluation.groupBy({
        by: ['circleId', 'attendance'],
        where: { circleId: { in: ids }, createdAt: { gte: since }, ...ATTENDANCE_DAY },
        _count: true,
      }),
      this.prisma.evaluation.groupBy({
        by: ['circleId'],
        where: { circleId: { in: ids }, createdAt: { gte: since }, score: { not: null } },
        _count: true,
      }),
    ]);

    const summaries = await this.plans.summaries(memberRows.map(({ studentId }) => studentId));

    return circles.map((circle) => {
      const members = memberRows.filter((row) => row.circleId === circle.id);
      const attendanceCounts: Partial<Record<AttendanceStatus, number>> = {};
      for (const row of attendance) {
        if (row.circleId === circle.id && row.attendance) attendanceCounts[row.attendance] = row._count;
      }
      return {
        id: circle.id,
        name: circle.name,
        teacher: circle.teacher && { id: circle.teacher.id, name: circle.teacher.fullName },
        capacity: circle.capacity,
        track: circle.trackTemplate,
        students: members.length,
        weeklyRecitations: recitations.find((row) => row.circleId === circle.id)?._count ?? 0,
        attendance: attendanceRate(attendanceCounts),
        commitment: average(members.map(({ studentId }) => summaries.get(studentId)?.commitment ?? null)),
        attendanceCounts,
      };
    });
  }
}

/** The rows whose place changes. A list that isn't exactly the current rows came from an out-of-date page. */
function placeChanges(rows: { id: string; position: number | null }[], orderedIds: string[]) {
  const current = new Map(rows.map(({ id, position }) => [id, position]));
  if (orderedIds.length !== current.size || orderedIds.some((id) => !current.has(id))) throw new ApiError(409, 'order_out_of_date');
  return orderedIds.flatMap((id, position) => (current.get(id) === position ? [] : [{ id, position }]));
}

function average(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.round(known.reduce((sum, value) => sum + value, 0) / known.length);
}

function publicCircle({ attendanceCounts: _counts, ...circle }: Awaited<ReturnType<SupervisorService['circleRows']>>[number]) {
  return circle;
}
