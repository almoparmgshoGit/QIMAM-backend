import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { TokensService } from '../auth/tokens.service.js';
import { ApiError } from '../common/api-error.js';
import { assertTrackFitsSection } from '../common/sections.js';
import { isUniqueViolation } from '../common/staff-api.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanService } from '../program/plan.service.js';
import { assertStudentFitsCircle } from '../supervisor/circle-track.js';
import { SupervisorService } from '../supervisor/supervisor.service.js';
import { TeacherProgramService } from '../teacher/teacher-program.service.js';
import { TeacherService } from '../teacher/teacher.service.js';
import type { UpdateStudentDto } from './admin.schemas.js';

const notFound = () => new ApiError(404, 'not_found');
const OPEN_TRANSFER = ['PENDING_ADMIN', 'PENDING_TEACHER'] as const;
/** The app's short names for the original tracks, kept in step with the template. */
import { ORIGINAL_TRACK } from '../program/track-change.service.js';

/** The administration's full control over one student: their file, account, circle and plan. */
@Injectable()
export class AdminStudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokensService,
    private readonly plans: PlanService,
    private readonly supervisors: SupervisorService,
    private readonly teachers: TeacherService,
    private readonly teacherProgram: TeacherProgramService,
  ) {}

  async detail(studentId: string) {
    const student = await this.prisma.user.findFirst({
      where: { id: studentId, role: 'STUDENT' },
      select: {
        id: true,
        fullName: true,
        phone: true,
        country: true,
        region: true,
        city: true,
        ageBand: true,
        section: true,
        language: true,
        status: true,
        trackStart: true,
        admissionStatus: true,
        admissionScore: true,
        admissionNote: true,
        admissionDecidedAt: true,
        createdAt: true,
        trackTemplate: { select: { id: true, name: true, code: true, kind: true } },
        memberships: {
          orderBy: { joinedAt: 'desc' },
          take: 20,
          select: { joinedAt: true, leftAt: true, circle: { select: { id: true, name: true, teacher: { select: { id: true, fullName: true } } } } },
        },
        transfers: {
          where: { status: { in: [...OPEN_TRANSFER] } },
          select: { id: true, status: true, createdAt: true, toCircle: { select: { id: true, name: true } } },
        },
      },
    });
    if (!student) throw notFound();

    const [file, sessions] = await Promise.all([
      this.teachers.studentFile(studentId, null),
      this.prisma.refreshToken.count({ where: { userId: studentId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    const current = student.memberships.find(({ leftAt }) => leftAt === null);
    const toCircle = ({ id, name, teacher }: (typeof student.memberships)[number]['circle']) => ({
      id,
      name,
      teacher: teacher && { id: teacher.id, name: teacher.fullName },
    });

    return {
      ...file,
      // The plan's standing, kept apart from the account's status below.
      planStatus: file.status,
      accountStatus: student.status,
      phone: student.phone,
      region: student.region,
      city: student.city,
      ageBand: student.ageBand,
      section: student.section,
      language: student.language,
      trackId: student.trackTemplate?.id ?? null,
      trackCode: student.trackTemplate?.code ?? null,
      trackStart: student.trackStart,
      admission: {
        status: student.admissionStatus,
        score: student.admissionScore === null ? null : Number(student.admissionScore),
        note: student.admissionNote,
        decidedAt: student.admissionDecidedAt,
      },
      createdAt: student.createdAt,
      circle: current ? toCircle(current.circle) : null,
      joinedAt: current?.joinedAt ?? null,
      circleHistory: student.memberships.map(({ joinedAt, leftAt, circle }) => ({ ...toCircle(circle), joinedAt, leftAt })),
      openTransfer: student.transfers[0] ?? null,
      activeSessions: sessions,
    };
  }

  /** The whole record, in every circle the student has been in. */
  async record(studentId: string) {
    const membership = await this.prisma.circleMembership.findFirst({ where: { studentId, leftAt: null }, select: { circleId: true } });
    if (!membership) await this.studentOrThrow(studentId);
    return this.teacherProgram.recordOf(studentId, membership?.circleId ?? null, false);
  }

  async update(admin: StaffActor, studentId: string, dto: UpdateStudentDto): Promise<void> {
    const student = await this.studentOrThrow(studentId);
    const { trackId, trackStart, ...fields } = dto;

    let trackData: { trackTemplateId: string; trackId: (typeof ORIGINAL_TRACK)[keyof typeof ORIGINAL_TRACK] | null } | undefined;
    let isStabilization = student.trackTemplate?.code === 'stabilization';
    const trackChanged = trackId !== undefined && trackId !== student.trackTemplateId;
    if (trackChanged) {
      const track = await this.prisma.trackTemplate.findFirst({ where: { id: trackId, active: true }, select: { id: true, code: true } });
      if (!track) throw new ApiError(409, 'track_closed');
      // A circle holds one track, so the student leaves or moves first.
      const membership = await this.prisma.circleMembership.findFirst({
        where: { studentId, leftAt: null },
        select: { circle: { select: { trackTemplateId: true } } },
      });
      if (membership && membership.circle.trackTemplateId !== track.id) throw new ApiError(409, 'track_mismatch_circle');
      trackData = { trackTemplateId: track.id, trackId: ORIGINAL_TRACK[track.code as keyof typeof ORIGINAL_TRACK] ?? null };
      isStabilization = track.code === 'stabilization';
    }
    // A track with online recitation is for the women's section only, so check the track and section as they will be.
    if (trackChanged || (fields.section !== undefined && fields.section !== student.section)) {
      const trackTemplateId = trackData?.trackTemplateId ?? student.trackTemplateId;
      const track = trackTemplateId
        ? await this.prisma.trackTemplate.findUnique({ where: { id: trackTemplateId }, select: { recitationMode: true } })
        : null;
      if (track) assertTrackFitsSection(track.recitationMode, fields.section ?? student.section);
    }
    // The sections never meet in a circle, so a student in one keeps its teacher's and classmates' section.
    if (fields.section !== undefined && fields.section !== student.section) {
      const other = { not: fields.section };
      const mixed = await this.prisma.circle.count({
        where: {
          archivedAt: null,
          memberships: { some: { studentId, leftAt: null } },
          OR: [
            { teacher: { section: other } },
            { memberships: { some: { leftAt: null, studentId: { not: studentId }, student: { section: other } } } },
          ],
        },
      });
      if (mixed > 0) throw new ApiError(409, 'section_mismatch');
    }
    // Only the stabilization track has a starting point.
    const nextStart = isStabilization ? (trackStart === undefined ? (student.trackStart ?? 'KAHF') : (trackStart ?? 'KAHF')) : null;
    const startChanged = nextStart !== student.trackStart;
    const phoneChanged = fields.phone !== undefined && fields.phone !== student.phone;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: studentId }, data: { ...fields, ...trackData, trackStart: nextStart } });
        if (trackChanged) {
          await tx.transferRequest.updateMany({ where: { studentId, status: { in: [...OPEN_TRANSFER] } }, data: { status: 'CANCELLED' } });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'identity_taken');
      throw error;
    }

    if (trackChanged || startChanged) await this.restartPlan(studentId);
    // A suspended account, or a number that is no longer theirs, signs out everywhere.
    if (dto.status === 'SUSPENDED' || phoneChanged) await this.tokens.revokeAllForUser(studentId);
    await this.audit.record(
      admin,
      'student.update',
      { type: 'student', id: studentId },
      {
        status: dto.status ?? null,
        trackId: trackChanged ? trackId : null,
        trackStart: startChanged ? nextStart : null,
        nameChanged: fields.fullName !== undefined,
        phoneChanged,
        countryChanged: fields.country !== undefined,
        locationChanged: fields.region !== undefined || fields.city !== undefined,
        section: fields.section ?? null,
      },
    );
  }

  /** Assigns a student who has no circle, or moves them at once. Unlike a transfer request, no teacher has to accept. */
  async move(admin: StaffActor, studentId: string, circleId: string): Promise<void> {
    await this.studentOrThrow(studentId);
    const circle = await this.prisma.circle.findFirst({ where: { id: circleId, archivedAt: null }, select: { id: true } });
    if (!circle) throw notFound();
    const current = await this.prisma.circleMembership.findFirst({ where: { studentId, leftAt: null }, select: { circleId: true } });
    if (!current) return this.supervisors.enrollStudent(admin, circleId, studentId);
    if (current.circleId === circleId) throw new ApiError(409, 'already_in_circle');
    await assertStudentFitsCircle(this.prisma, circleId, studentId);

    try {
      await this.prisma.$transaction(async (tx) => {
        // Serializes joins to the circle, as enrolling does, so the capacity check holds.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${circleId}::text, 0))::text`;
        const target = await tx.circle.findUniqueOrThrow({ where: { id: circleId }, select: { capacity: true } });
        const size = await tx.circleMembership.count({ where: { circleId, leftAt: null } });
        if (size >= target.capacity) throw new ApiError(409, 'circle_full');

        const left = await tx.circleMembership.updateMany({ where: { studentId, circleId: current.circleId, leftAt: null }, data: { leftAt: new Date() } });
        if (left.count !== 1) throw new ApiError(409, 'already_moved');
        await tx.transferRequest.updateMany({ where: { studentId, status: { in: [...OPEN_TRANSFER] } }, data: { status: 'CANCELLED' } });
        await tx.liveSession.updateMany({ where: { circleId: current.circleId, studentId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
        await tx.circleMembership.create({ data: { studentId, circleId } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'already_assigned');
      throw error;
    }
    await this.plans.startPlan(studentId);
    await this.audit.record(admin, 'student.move', { type: 'student', id: studentId }, { from: current.circleId, to: circleId });
  }

  /** Starts the plan again from the beginning of the track. Passed gates stay as the student's history. */
  async resetPlan(admin: StaffActor, studentId: string): Promise<void> {
    await this.studentOrThrow(studentId);
    await this.restartPlan(studentId);
    await this.audit.record(admin, 'student.reset_plan', { type: 'student', id: studentId });
  }

  async signOut(admin: StaffActor, studentId: string): Promise<void> {
    await this.studentOrThrow(studentId);
    await this.tokens.revokeAllForUser(studentId);
    await this.audit.record(admin, 'student.sign_out', { type: 'student', id: studentId });
  }

  /** Permanent. The student's data goes with the account through the foreign keys, and the audit keeps the id only. */
  async remove(admin: StaffActor, studentId: string): Promise<void> {
    const student = await this.studentOrThrow(studentId);
    await this.prisma.$transaction(async (tx) => {
      if (student.phone) await tx.otpChallenge.deleteMany({ where: { phone: student.phone } });
      await tx.user.delete({ where: { id: studentId } });
    });
    await this.audit.record(admin, 'student.delete', { type: 'student', id: studentId });
  }

  private async restartPlan(studentId: string): Promise<void> {
    const hadPlan = await this.prisma.studentPlan.findUnique({ where: { studentId }, select: { id: true } });
    const inCircle = await this.prisma.circleMembership.count({ where: { studentId, leftAt: null } });
    // A student without a circle gets their plan when they join one, as on sign-up.
    await this.plans.restartPlan(studentId, Boolean(hadPlan) || inCircle > 0);
  }

  private async studentOrThrow(studentId: string) {
    const student = await this.prisma.user.findFirst({
      where: { id: studentId, role: 'STUDENT' },
      select: { id: true, phone: true, section: true, trackStart: true, trackTemplateId: true, trackTemplate: { select: { code: true } } },
    });
    if (!student) throw notFound();
    return student;
  }
}
