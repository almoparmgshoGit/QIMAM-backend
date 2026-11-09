import { Injectable } from '@nestjs/common';
import { StaffAuthService } from '../auth/staff-auth.service.js';
import type { StaffActor } from '../auth/staff.decorators.js';
import { TokensService } from '../auth/tokens.service.js';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation, pageArgs } from '../common/staff-api.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanService } from '../program/plan.service.js';
import { assertOpenTrack } from '../supervisor/circle-track.js';
import type {
  CreateAdminCircleDto,
  CreateStaffDto,
  CreateStudentDto,
  ListAuditDto,
  ListStaffDto,
  ListStudentsDto,
  ListTransfersDto,
  UpdateStaffDto,
} from './admin.schemas.js';

const notFound = () => new ApiError(404, 'not_found');

export const STAFF_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  scope: { select: { id: true, name: true } },
  createdAt: true,
  staffCredential: { select: { passwordHash: true, totpEnabledAt: true } },
} as const;

type StaffRow = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  scope: { id: string; name: string } | null;
  createdAt: Date;
  staffCredential: { passwordHash: string | null; totpEnabledAt: Date | null } | null;
};

/** Lists show a masked number: enough to recognize it, and useless if the screen is seen or copied. */
const maskPhone = (phone: string | null) => (phone ? `${phone.slice(0, 4)} ••• ••${phone.slice(-2)}` : null);

export const toStaff = ({ staffCredential, fullName, ...row }: StaffRow) => ({
  ...row,
  name: fullName,
  // Whether a password exists, never the hash.
  passwordSet: Boolean(staffCredential?.passwordHash),
  totpEnabled: Boolean(staffCredential?.totpEnabledAt),
});

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly staffAuth: StaffAuthService,
    private readonly tokens: TokensService,
    private readonly plans: PlanService,
  ) {}

  async listStaff(query: ListStaffDto) {
    const where = {
      role: query.role ?? { not: 'STUDENT' as const },
      ...(query.scopeId ? { scopeId: query.scopeId } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, ...pageArgs(query), orderBy: { createdAt: 'desc' }, select: STAFF_SELECT }),
    ]);
    return { total, items: await this.withAssignments(items.map(toStaff)) };
  }

  /** What each account answers for: a supervisor for her whole scope, a teacher for her own circles. */
  private async withAssignments(rows: ReturnType<typeof toStaff>[]) {
    const teacherIds = rows.filter(({ role }) => role === 'TEACHER').map(({ id }) => id);
    const scopeIds = [...new Set(rows.flatMap(({ scope }) => (scope ? [scope.id] : [])))];
    const [circles, teachers, supervisors] = await Promise.all([
      this.prisma.circle.findMany({
        where: { archivedAt: null, OR: [{ teacherId: { in: teacherIds } }, { scopeId: { in: scopeIds } }] },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, scopeId: true, teacherId: true, _count: { select: { memberships: { where: { leftAt: null } } } } },
      }),
      this.prisma.user.groupBy({ by: ['scopeId'], where: { role: 'TEACHER', scopeId: { in: scopeIds } }, _count: true }),
      this.prisma.user.findMany({
        where: { role: 'SUPERVISOR', scopeId: { in: scopeIds } },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, scopeId: true },
      }),
    ]);

    return rows.map((row) => {
      const isSupervisor = row.role === 'SUPERVISOR';
      const own = circles.filter(({ scopeId, teacherId }) => (isSupervisor ? scopeId === row.scope?.id : teacherId === row.id));
      return {
        ...row,
        circles: own.map(({ id, name, _count }) => ({ id, name, students: _count.memberships })),
        students: own.reduce((sum, { _count }) => sum + _count.memberships, 0),
        teachers: isSupervisor ? (teachers.find(({ scopeId }) => scopeId === row.scope?.id)?._count ?? 0) : null,
        supervisors:
          row.role === 'TEACHER'
            ? supervisors.filter(({ scopeId }) => scopeId === row.scope?.id).map(({ id, fullName }) => ({ id, name: fullName }))
            : [],
      };
    });
  }

  /** Accounts have no password until their owner sets one, through the single-use link returned here. */
  async createStaff(admin: StaffActor, dto: CreateStaffDto) {
    if (dto.scopeId) await this.assertScope(dto.scopeId);
    if (dto.circleId) {
      const free = await this.prisma.circle.findFirst({ where: { id: dto.circleId, scopeId: dto.scopeId, teacherId: null, archivedAt: null }, select: { id: true } });
      if (!free) throw new ApiError(409, 'circle_not_free');
    }
    try {
      const user = await this.prisma.user.create({
        data: {
          fullName: dto.fullName,
          email: dto.email,
          phone: dto.phone,
          role: dto.role,
          scopeId: dto.scopeId,
          staffCredential: { create: {} },
        },
        select: STAFF_SELECT,
      });
      if (dto.circleId) {
        // The condition means two new teachers can't take the same circle.
        const { count } = await this.prisma.circle.updateMany({ where: { id: dto.circleId, teacherId: null }, data: { teacherId: user.id } });
        if (count !== 1) {
          await this.prisma.user.delete({ where: { id: user.id } });
          throw new ApiError(409, 'circle_not_free');
        }
      }
      const setup = await this.staffAuth.issueSetupToken(user.id);
      await this.audit.record(admin, 'staff.create', { type: 'user', id: user.id }, { role: dto.role });
      return { staff: toStaff(user), ...setup };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'identity_taken');
      throw error;
    }
  }

  async updateStaff(admin: StaffActor, staffId: string, dto: UpdateStaffDto) {
    // Stops an administrator from locking out the last way in by accident.
    if (staffId === admin.id && dto.status) throw new ApiError(409, 'cannot_change_own_account');
    const staff = await this.staffOrThrow(staffId);

    if (dto.scopeId) {
      if (staff.role === 'ADMIN') throw new ApiError(400, 'admin_has_no_scope');
      await this.assertScope(dto.scopeId);
      if (dto.scopeId !== staff.scopeId) {
        const circles = await this.prisma.circle.count({ where: { teacherId: staffId, archivedAt: null } });
        if (circles > 0) throw new ApiError(409, 'teacher_has_circles');
      }
    }
    if (dto.status === 'SUSPENDED') {
      const circles = await this.prisma.circle.count({ where: { teacherId: staffId, archivedAt: null } });
      if (circles > 0) throw new ApiError(409, 'teacher_has_circles');
    }

    try {
      const updated = await this.prisma.user.update({ where: { id: staffId }, data: dto, select: STAFF_SELECT });
      if (dto.status === 'SUSPENDED') await this.tokens.revokeAllForUser(staffId);
      // Which contact details changed, not their values.
      await this.audit.record(
        admin,
        'staff.update',
        { type: 'user', id: staffId },
        { status: dto.status ?? null, scopeId: dto.scopeId ?? null, emailChanged: dto.email !== undefined, phoneChanged: dto.phone !== undefined },
      );
      return toStaff(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'identity_taken');
      throw error;
    }
  }

  /** For a forgotten password or a lost authenticator: both are cleared, and a new setup link is issued. */
  async resetStaffCredentials(admin: StaffActor, staffId: string) {
    if (staffId === admin.id) throw new ApiError(409, 'cannot_change_own_account');
    await this.staffOrThrow(staffId);

    await this.prisma.staffCredential.upsert({
      where: { userId: staffId },
      update: { passwordHash: null, totpSecretEncrypted: null, totpEnabledAt: null, totpLastStep: null, failedAttempts: 0, lockedUntil: null },
      create: { userId: staffId },
    });
    await this.tokens.revokeAllForUser(staffId);
    const setup = await this.staffAuth.issueSetupToken(staffId);
    await this.audit.record(admin, 'staff.reset_credentials', { type: 'user', id: staffId });
    return setup;
  }

  listScopes() {
    return this.prisma.scope.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, createdAt: true } });
  }

  async createScope(admin: StaffActor, name: string) {
    try {
      const scope = await this.prisma.scope.create({ data: { name }, select: { id: true, name: true } });
      await this.audit.record(admin, 'scope.create', { type: 'scope', id: scope.id });
      return scope;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'name_taken');
      throw error;
    }
  }

  async renameScope(admin: StaffActor, scopeId: string, name: string) {
    await this.assertScope(scopeId);
    try {
      const scope = await this.prisma.scope.update({ where: { id: scopeId }, data: { name }, select: { id: true, name: true } });
      await this.audit.record(admin, 'scope.rename', { type: 'scope', id: scopeId });
      return scope;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'name_taken');
      throw error;
    }
  }

  async listStudents(query: ListStudentsDto) {
    const where = {
      role: 'STUDENT' as const,
      ...(query.search ? { fullName: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.trackId ? { trackTemplateId: query.trackId } : {}),
      ...(query.section ? { section: query.section } : {}),
      ...(query.status === 'suspended' ? { status: 'SUSPENDED' as const } : {}),
      ...(query.status === 'active' ? { status: 'ACTIVE' as const, memberships: { some: { leftAt: null } } } : {}),
      ...(query.status === 'awaitingAssignment' ? { status: 'ACTIVE' as const, admissionStatus: 'ACCEPTED' as const, memberships: { none: { leftAt: null } } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        ...pageArgs(query),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fullName: true,
          phone: true,
          country: true,
          ageBand: true,
          section: true,
          trackTemplate: { select: { id: true, name: true } },
          status: true,
          createdAt: true,
          memberships: { where: { leftAt: null }, select: { circle: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    return {
      total,
      items: items.map(({ fullName, memberships, phone, trackTemplate, status, ...row }) => ({
        ...row,
        name: fullName,
        phone: maskPhone(phone),
        track: trackTemplate,
        circle: memberships[0]?.circle ?? null,
        status: status === 'SUSPENDED' ? 'suspended' : memberships.length === 0 ? 'awaitingAssignment' : 'active',
      })),
    };
  }

  /** The student signs in with this number by code. They accept the pledges when they first complete sign-up. */
  async createStudent(admin: StaffActor, dto: CreateStudentDto) {
    const track = await this.prisma.trackTemplate.findFirst({ where: { id: dto.trackId, active: true }, select: { id: true, code: true } });
    if (!track) throw new ApiError(409, 'track_closed');
    const original = { advanced: 'ADVANCED', steady: 'STEADY', stabilization: 'STABILIZATION' } as const;
    try {
      const student = await this.prisma.user.create({
        data: {
          fullName: dto.fullName,
          phone: dto.phone,
          country: dto.country,
          section: dto.section,
          trackTemplateId: track.id,
          trackId: original[track.code as keyof typeof original] ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(admin, 'student.create', { type: 'student', id: student.id });
      return student;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'identity_taken');
      throw error;
    }
  }

  async listCircles() {
    const circles = await this.prisma.circle.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        capacity: true,
        scope: { select: { id: true, name: true } },
        teacher: { select: { id: true, fullName: true } },
        trackTemplate: { select: { id: true, name: true } },
        _count: { select: { memberships: { where: { leftAt: null } } } },
      },
    });
    return circles.map(({ _count, teacher, trackTemplate, ...circle }) => ({
      ...circle,
      teacher: teacher && { id: teacher.id, name: teacher.fullName },
      track: trackTemplate,
      students: _count.memberships,
    }));
  }

  async createCircle(admin: StaffActor, dto: CreateAdminCircleDto) {
    await this.assertScope(dto.scopeId);
    await assertOpenTrack(this.prisma, dto.trackId);
    if (dto.teacherId) {
      const teacher = await this.prisma.user.findFirst({
        where: { id: dto.teacherId, role: 'TEACHER', scopeId: dto.scopeId, status: 'ACTIVE' },
        select: { taughtCircles: { where: { archivedAt: null }, select: { id: true } } },
      });
      if (!teacher) throw notFound();
      if (teacher.taughtCircles.length > 0) throw new ApiError(409, 'teacher_busy');
    }
    const circle = await this.prisma.circle.create({
      data: { name: dto.name, scopeId: dto.scopeId, teacherId: dto.teacherId, capacity: dto.capacity, trackTemplateId: dto.trackId },
      select: { id: true },
    });
    await this.audit.record(admin, 'circle.create', { type: 'circle', id: circle.id });
    return circle;
  }

  async setStudentStatus(admin: StaffActor, studentId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    const { count } = await this.prisma.user.updateMany({ where: { id: studentId, role: 'STUDENT' }, data: { status } });
    if (count !== 1) throw notFound();
    if (status === 'SUSPENDED') await this.tokens.revokeAllForUser(studentId);
    await this.audit.record(admin, 'student.set_status', { type: 'student', id: studentId }, { status });
  }

  async listTransfers(query: ListTransfersDto) {
    const where = { status: query.status };
    const [total, items] = await Promise.all([
      this.prisma.transferRequest.count({ where }),
      this.prisma.transferRequest.findMany({
        where,
        ...pageArgs(query),
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
          student: { select: { id: true, fullName: true } },
          fromCircle: { select: { id: true, name: true } },
          toCircle: { select: { id: true, name: true } },
        },
      }),
    ]);
    return {
      total,
      items: items.map(({ student, ...row }) => ({ ...row, student: { id: student.id, name: student.fullName } })),
    };
  }

  approveTransfer(admin: StaffActor, id: string) {
    return this.decideTransfer(admin, id, 'PENDING_TEACHER', 'transfer.approve');
  }

  rejectTransfer(admin: StaffActor, id: string) {
    return this.decideTransfer(admin, id, 'REJECTED', 'transfer.deny');
  }

  async listAudit(query: ListAuditDto) {
    const where = query.actorId ? { actorId: query.actorId } : {};
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, ...pageArgs(query), orderBy: { createdAt: 'desc' } }),
    ]);
    return { total, items };
  }

  private async decideTransfer(admin: StaffActor, id: string, status: 'PENDING_TEACHER' | 'REJECTED', action: string): Promise<void> {
    const { count } = await this.prisma.transferRequest.updateMany({ where: { id, status: 'PENDING_ADMIN' }, data: { status } });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, action, { type: 'transfer', id });
  }

  private async staffOrThrow(staffId: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, role: { not: 'STUDENT' } },
      select: { id: true, role: true, scopeId: true },
    });
    if (!staff) throw notFound();
    return staff;
  }

  async assertScope(scopeId: string): Promise<void> {
    const scope = await this.prisma.scope.findUnique({ where: { id: scopeId }, select: { id: true } });
    if (!scope) throw new ApiError(400, 'unknown_scope');
  }
}
