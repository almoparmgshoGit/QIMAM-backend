import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { assertTeacherFitsCircle } from '../common/sections.js';
import { isUniqueViolation } from '../common/staff-api.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertStudentFitsCircle, assertTrackFitsCircle } from '../supervisor/circle-track.js';
import type { RequestTransferDto } from '../supervisor/supervisor.schemas.js';
import { NotificationsService } from '../program/notifications.service.js';
import { SupervisorService } from '../supervisor/supervisor.service.js';
import type { UpdateAdminCircleDto } from './admin.schemas.js';
import { AdminService, STAFF_SELECT, toStaff } from './admin.service.js';

const OPEN_TRANSFER = ['PENDING_ADMIN', 'PENDING_TEACHER'] as const;
const RECENT_ANNOUNCEMENTS = 10;

const notFound = () => new ApiError(404, 'not_found');

const TRANSFER_SELECT = {
  id: true,
  status: true,
  createdAt: true,
  student: { select: { id: true, fullName: true } },
  fromCircle: { select: { id: true, name: true } },
  toCircle: { select: { id: true, name: true } },
} as const;

type TransferRow = {
  id: string;
  status: string;
  createdAt: Date;
  student: { id: string; fullName: string };
  fromCircle: { id: string; name: string } | null;
  toCircle: { id: string; name: string };
};

const toTransfer = ({ student, ...row }: TransferRow) => ({ ...row, student: { id: student.id, name: student.fullName } });

/** The administration's view of who answers for what: supervisor, scope, teachers, circles, students. */
@Injectable()
export class AdminStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: AdminService,
    private readonly supervisors: SupervisorService,
    private readonly notifications: NotificationsService,
  ) {}

  async supervisorDetail(supervisorId: string) {
    const supervisor = await this.prisma.user.findFirst({ where: { id: supervisorId, role: 'SUPERVISOR' }, select: STAFF_SELECT });
    if (!supervisor) throw notFound();
    const account = toStaff(supervisor);

    // A supervisor without a scope answers for nothing yet, which the page shows rather than treats as an error.
    const scopeId = account.scope?.id;
    if (!scopeId) return { account, colleagues: [], stats: null, teachers: [], circles: [], transfers: [], announcements: [] };

    const [overview, colleagues, teachers, transfers, announcements] = await Promise.all([
      this.supervisors.scopeOverview(scopeId),
      this.prisma.user.findMany({
        where: { role: 'SUPERVISOR', scopeId, id: { not: supervisorId } },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true },
      }),
      this.prisma.user.findMany({
        where: { role: 'TEACHER', scopeId },
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          status: true,
          taughtCircles: {
            where: { archivedAt: null },
            select: { id: true, name: true, _count: { select: { memberships: { where: { leftAt: null } } } } },
          },
        },
      }),
      this.prisma.transferRequest.findMany({
        where: { status: { in: [...OPEN_TRANSFER] }, OR: [{ toCircle: { scopeId } }, { fromCircle: { scopeId } }] },
        orderBy: { createdAt: 'desc' },
        select: TRANSFER_SELECT,
      }),
      this.prisma.announcement.findMany({
        where: { OR: [{ scopeId }, { circle: { scopeId } }] },
        orderBy: { createdAt: 'desc' },
        take: RECENT_ANNOUNCEMENTS,
        select: {
          id: true,
          title: true,
          publishedAt: true,
          createdAt: true,
          circle: { select: { id: true, name: true } },
          author: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    return {
      account,
      colleagues: colleagues.map(({ id, fullName }) => ({ id, name: fullName })),
      stats: overview.stats,
      circles: overview.circles,
      teachers: teachers.map(({ id, fullName, status, taughtCircles }) => ({
        id,
        name: fullName,
        status,
        circles: taughtCircles.map(({ id: circleId, name, _count }) => ({ id: circleId, name, students: _count.memberships })),
      })),
      transfers: transfers.map(toTransfer),
      announcements: announcements.map(({ author, ...row }) => ({ ...row, author: author?.fullName ?? null })),
    };
  }

  async teacherDetail(teacherId: string) {
    const teacher = await this.prisma.user.findFirst({ where: { id: teacherId, role: 'TEACHER' }, select: STAFF_SELECT });
    if (!teacher) throw notFound();
    const account = toStaff(teacher);

    const [overview, supervisors, transfers] = await Promise.all([
      this.supervisors.teacherOverview(teacherId),
      account.scope
        ? this.prisma.user.findMany({
            where: { role: 'SUPERVISOR', scopeId: account.scope.id },
            orderBy: { fullName: 'asc' },
            select: { id: true, fullName: true, status: true },
          })
        : [],
      this.prisma.transferRequest.findMany({
        where: {
          status: { in: [...OPEN_TRANSFER] },
          OR: [{ toCircle: { teacherId } }, { fromCircle: { teacherId } }],
        },
        orderBy: { createdAt: 'desc' },
        select: TRANSFER_SELECT,
      }),
    ]);

    return {
      account,
      supervisors: supervisors.map(({ id, fullName, status }) => ({ id, name: fullName, status })),
      ...overview,
      transfers: transfers.map(toTransfer),
    };
  }

  /** Moves a teacher to another supervisor's scope, and her circles and their students with her. */
  async moveTeacher(admin: StaffActor, teacherId: string, scopeId: string): Promise<void> {
    await this.accounts.assertScope(scopeId);
    const teacher = await this.prisma.user.findFirst({ where: { id: teacherId, role: 'TEACHER' }, select: { scopeId: true } });
    if (!teacher) throw notFound();
    if (teacher.scopeId === scopeId) return;

    const [, moved] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: teacherId }, data: { scopeId } }),
      this.prisma.circle.updateMany({ where: { teacherId, archivedAt: null }, data: { scopeId } }),
    ]);
    await this.audit.record(admin, 'teacher.move_scope', { type: 'user', id: teacherId }, { scopeId, circles: moved.count });
  }

  async updateCircle(admin: StaffActor, circleId: string, dto: UpdateAdminCircleDto): Promise<void> {
    const circle = await this.activeCircle(circleId);
    const scopeId = dto.scopeId ?? circle.scopeId;
    const teacherId = dto.teacherId === undefined ? circle.teacherId : dto.teacherId;
    const teacherChanged = teacherId !== circle.teacherId;

    if (dto.scopeId) await this.accounts.assertScope(dto.scopeId);
    if (teacherId && teacherChanged) {
      await this.supervisors.assertAvailableTeacher(scopeId, teacherId);
      await assertTeacherFitsCircle(this.prisma, circleId, teacherId);
    }
    // A circle stays in its teacher's scope, so her supervisor can see it.
    if (teacherId && !teacherChanged && scopeId !== circle.scopeId) {
      const teacher = await this.prisma.user.findUnique({ where: { id: teacherId }, select: { scopeId: true } });
      if (teacher?.scopeId !== scopeId) throw new ApiError(409, 'teacher_other_scope');
    }
    if (dto.capacity !== undefined) {
      const size = await this.prisma.circleMembership.count({ where: { circleId, leftAt: null } });
      if (dto.capacity < size) throw new ApiError(409, 'capacity_below_students');
    }
    if (dto.trackId) {
      const track = await this.prisma.trackTemplate.findUnique({ where: { id: dto.trackId }, select: { id: true } });
      if (!track) throw new ApiError(400, 'unknown_track');
      await assertTrackFitsCircle(this.prisma, circleId, dto.trackId);
    }

    await this.prisma.$transaction([
      this.prisma.circle.update({
        where: { id: circleId },
        data: { name: dto.name, capacity: dto.capacity, scopeId, teacherId, trackTemplateId: dto.trackId },
      }),
      // The previous teacher can no longer reach these students, so her upcoming sessions can't take place.
      ...(teacherChanged && circle.teacherId
        ? [this.prisma.liveSession.updateMany({ where: { circleId, teacherId: circle.teacherId, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } })]
        : []),
    ]);
    await this.audit.record(admin, 'circle.update', { type: 'circle', id: circleId }, { ...dto });
  }

  async archiveCircle(admin: StaffActor, circleId: string): Promise<void> {
    await this.activeCircle(circleId);
    await this.supervisors.archiveEmptyCircle(admin, circleId);
  }

  async assignStudent(admin: StaffActor, circleId: string, studentId: string): Promise<void> {
    await this.activeCircle(circleId);
    await this.supervisors.enrollStudent(admin, circleId, studentId);
  }

  async removeStudent(admin: StaffActor, circleId: string, studentId: string): Promise<void> {
    await this.supervisors.removeFromCircle(admin, circleId, studentId);
  }

  /** The administration's own request needs no permission step, but the new teacher still accepts it. */
  async requestTransfer(admin: StaffActor, { studentId, toCircleId }: RequestTransferDto) {
    const circle = await this.activeCircle(toCircleId);
    if (!circle.teacherId) throw new ApiError(409, 'circle_has_no_teacher');
    const membership = await this.prisma.circleMembership.findFirst({ where: { studentId, leftAt: null }, select: { circleId: true } });
    if (!membership) throw notFound();
    if (membership.circleId === toCircleId) throw new ApiError(409, 'already_in_circle');
    await assertStudentFitsCircle(this.prisma, toCircleId, studentId);

    try {
      const transfer = await this.prisma.transferRequest.create({
        data: { studentId, fromCircleId: membership.circleId, toCircleId, requestedById: admin.id, status: 'PENDING_TEACHER' },
        select: { id: true, status: true },
      });
      await this.audit.record(admin, 'transfer.request', { type: 'transfer', id: transfer.id }, { studentId, toCircleId });
      await this.notifications.transferAwaitsTeacher(transfer.id);
      return transfer;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'transfer_in_progress');
      throw error;
    }
  }

  async cancelTransfer(admin: StaffActor, transferId: string): Promise<void> {
    const { count } = await this.prisma.transferRequest.updateMany({
      where: { id: transferId, status: { in: [...OPEN_TRANSFER] } },
      data: { status: 'CANCELLED' },
    });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'transfer.cancel', { type: 'transfer', id: transferId });
  }

  private async activeCircle(circleId: string) {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, archivedAt: null },
      select: { id: true, scopeId: true, teacherId: true },
    });
    if (!circle) throw notFound();
    return circle;
  }
}
