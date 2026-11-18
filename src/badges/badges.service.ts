import { Injectable } from '@nestjs/common';
import { isAdministration, type StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { randomId } from '../common/ids.js';
import { pageArgs } from '../common/staff-api.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { BadgeAudience, Role } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { badgeProgress, describeTrigger } from '../program/badge-rules.js';
import { NotificationsService } from '../program/notifications.service.js';
import { PlanService } from '../program/plan.service.js';
import { filePaths, StorageService } from '../storage/storage.service.js';
import { assertBadgePng } from './badge-image.js';
import type { AwardDto, AwardsQuery, CreateBadgeDto, RecipientsQuery, UpdateBadgeDto } from './badges.schemas.js';

const notFound = () => new ApiError(404, 'not_found');

/** How many badges a holder can show beside her name. */
export const MAX_PINNED = 3;

/** Everything a client needs to draw a badge. Never the picture itself. */
const LOOK = {
  id: true,
  label: true,
  condition: true,
  visual: true,
  icon: true,
  color: true,
  trigger: true,
  threshold: true,
  image: { select: { updatedAt: true } },
} satisfies Prisma.BadgeSelect;

type LookRow = Prisma.BadgeGetPayload<{ select: typeof LOOK }>;

/** The parts of a badge every screen shows. The picture's address changes with it, so caches never show an old one. */
export function badgeLook({ image, ...badge }: LookRow) {
  return {
    id: badge.id,
    label: badge.label,
    condition: badge.condition || describeTrigger(badge.trigger, badge.threshold),
    visual: badge.visual,
    icon: badge.icon,
    color: badge.color,
    imageUrl: badge.visual === 'IMAGE' && image ? `/badges/${badge.id}/image?v=${image.updatedAt.getTime()}` : null,
  };
}

const HOLDERS: Record<BadgeAudience, Role[]> = {
  STUDENTS: ['STUDENT'],
  STAFF: ['TEACHER', 'SUPERVISOR'],
  EVERYONE: ['STUDENT', 'TEACHER', 'SUPERVISOR'],
};

@Injectable()
export class BadgesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly plans: PlanService,
    private readonly storage: StorageService,
  ) {}

  // ---------- Managing badges (administrators) ----------

  async list() {
    const badges = await this.prisma.badge.findMany({
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      select: { ...LOOK, code: true, audience: true, supervisorCanAward: true, active: true, _count: { select: { awards: true } } },
    });
    return {
      badges: badges.map((badge) => ({
        ...badgeLook(badge),
        // The text as the administrator wrote it, so editing never saves the generated one.
        customCondition: badge.condition,
        code: badge.code,
        audience: badge.audience,
        trigger: badge.trigger,
        threshold: badge.threshold,
        supervisorCanAward: badge.supervisorCanAward,
        active: badge.active,
        awarded: badge._count.awards,
      })),
    };
  }

  async create(admin: StaffActor, { look, ...badge }: CreateBadgeDto) {
    const { id } = await this.prisma.badge.create({
      data: { ...badge, condition: badge.condition || null, visual: look.visual, icon: 'icon' in look ? look.icon : '', code: randomId() },
      select: { id: true },
    });
    await this.audit.record(admin, 'badge.create', { type: 'badge', id });
    return { id };
  }

  async update(admin: StaffActor, id: string, { look, ...changes }: UpdateBadgeDto): Promise<void> {
    const data: Prisma.BadgeUpdateManyMutationInput = { ...changes };
    if (changes.condition !== undefined) data.condition = changes.condition || null;
    if (look) {
      data.visual = look.visual;
      if ('icon' in look) data.icon = look.icon;
    }
    const { count } = await this.prisma.badge.updateMany({ where: { id }, data });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'badge.update', { type: 'badge', id });
  }

  /** Removes the badge from everyone who holds it. */
  async remove(admin: StaffActor, id: string): Promise<void> {
    const { count } = await this.prisma.badge.deleteMany({ where: { id } });
    if (count !== 1) throw notFound();
    await this.storage.remove(filePaths.badgeImage(id));
    await this.audit.record(admin, 'badge.delete', { type: 'badge', id });
  }

  /** The picture goes to the uploads folder. Its row keeps only when it changed, for the address that busts caches. */
  async setImage(admin: StaffActor, id: string, file: { buffer: Buffer } | undefined) {
    const data = assertBadgePng(file);
    const badge = await this.prisma.badge.findUnique({ where: { id }, select: { id: true } });
    if (!badge) throw notFound();
    await this.storage.write(filePaths.badgeImage(id), data);
    const image = await this.prisma.badgeImage.upsert({
      where: { badgeId: id },
      create: { badgeId: id, data: null },
      // An older copy kept in the database is no longer the picture.
      update: { data: null, updatedAt: new Date() },
      select: { updatedAt: true },
    });
    await this.audit.record(admin, 'badge.image', { type: 'badge', id });
    return { imageUrl: `/badges/${id}/image?v=${image.updatedAt.getTime()}` };
  }

  /** From the uploads folder, or, for a picture saved before files moved there, from the database. */
  async image(id: string): Promise<Buffer> {
    const onDisk = await this.storage.read(filePaths.badgeImage(id));
    if (onDisk) return onDisk;
    const image = await this.prisma.badgeImage.findUnique({ where: { badgeId: id }, select: { data: true } });
    if (!image?.data) throw notFound();
    return Buffer.from(image.data);
  }

  // ---------- Giving badges (administrators and supervisors) ----------

  /** Administrators reach everyone. A supervisor reaches the students in her scope's circles and its teachers. */
  private studentsOf(staff: StaffActor): Prisma.UserWhereInput {
    if (isAdministration(staff)) return { role: 'STUDENT', status: 'ACTIVE' };
    return {
      role: 'STUDENT',
      status: 'ACTIVE',
      memberships: { some: { leftAt: null, circle: { scopeId: this.scopeOf(staff), archivedAt: null } } },
    };
  }

  private staffOf(staff: StaffActor): Prisma.UserWhereInput {
    if (isAdministration(staff)) return { role: { in: ['TEACHER', 'SUPERVISOR'] }, status: 'ACTIVE' };
    return { role: 'TEACHER', scopeId: this.scopeOf(staff), status: 'ACTIVE' };
  }

  private scopeOf(staff: StaffActor): string {
    if (!staff.scopeId) throw new ApiError(403, 'no_scope');
    return staff.scopeId;
  }

  private canGive(staff: StaffActor): Prisma.BadgeWhereInput {
    return isAdministration(staff) ? { active: true } : { active: true, supervisorCanAward: true };
  }

  async awardable(staff: StaffActor) {
    const badges = await this.prisma.badge.findMany({
      where: { ...this.canGive(staff), ...(isAdministration(staff) ? {} : { audience: { in: ['STUDENTS', 'STAFF', 'EVERYONE'] } }) },
      orderBy: { createdAt: 'asc' },
      select: { ...LOOK, audience: true },
    });
    return badges.map((badge) => ({ ...badgeLook(badge), audience: badge.audience, automatic: badge.trigger !== 'MANUAL' }));
  }

  async recipients(staff: StaffActor, { kind, q }: RecipientsQuery) {
    const where = kind === 'STUDENT' ? this.studentsOf(staff) : this.staffOf(staff);
    const users = await this.prisma.user.findMany({
      where: { AND: [where, q ? { fullName: { contains: q, mode: 'insensitive' } } : {}] },
      orderBy: { fullName: 'asc' },
      take: 30,
      select: {
        id: true,
        fullName: true,
        role: true,
        scope: { select: { name: true } },
        memberships: { where: { leftAt: null }, take: 1, select: { circle: { select: { name: true } } } },
        badges: { select: { badgeId: true } },
      },
    });
    return users.map((user) => ({
      id: user.id,
      name: user.fullName,
      role: user.role,
      detail: user.role === 'STUDENT' ? (user.memberships[0]?.circle.name ?? null) : (user.scope?.name ?? null),
      heldBadgeIds: user.badges.map(({ badgeId }) => badgeId),
    }));
  }

  async awards(staff: StaffActor, query: AwardsQuery) {
    const where: Prisma.StudentBadgeWhereInput = { student: { OR: [this.studentsOf(staff), this.staffOf(staff)] } };
    const [total, rows] = await Promise.all([
      this.prisma.studentBadge.count({ where }),
      this.prisma.studentBadge.findMany({
        where,
        orderBy: { awardedAt: 'desc' },
        ...pageArgs(query),
        select: {
          awardedAt: true,
          note: true,
          awardedById: true,
          badge: { select: LOOK },
          student: { select: { id: true, fullName: true, role: true } },
          awardedBy: { select: { fullName: true } },
        },
      }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        badge: badgeLook(row.badge),
        holder: { id: row.student.id, name: row.student.fullName, role: row.student.role },
        // No one gave it when the program did.
        awardedBy: row.awardedBy?.fullName ?? null,
        automatic: row.awardedById === null,
        awardedAt: row.awardedAt,
        note: row.note,
        canRevoke: isAdministration(staff) || row.awardedById === staff.id,
      })),
    };
  }

  async award(staff: StaffActor, { badgeId, userId, note }: AwardDto): Promise<void> {
    const [badge, holder] = await Promise.all([
      this.prisma.badge.findFirst({ where: { id: badgeId, ...this.canGive(staff) }, select: { label: true, audience: true } }),
      this.prisma.user.findFirst({ where: { id: userId, OR: [this.studentsOf(staff), this.staffOf(staff)] }, select: { role: true } }),
    ]);
    if (!badge || !holder) throw notFound();
    if (!HOLDERS[badge.audience].includes(holder.role)) throw new ApiError(409, 'badge_not_for_recipient');

    const { count } = await this.prisma.studentBadge.createMany({
      data: [{ studentId: userId, badgeId, awardedById: staff.id, note: note || null }],
      skipDuplicates: true,
    });
    if (count !== 1) throw new ApiError(409, 'badge_already_held');

    await this.notifications.send([userId], {
      type: 'BADGES',
      title: 'شارة جديدة',
      body: note ? `${badge.label}: ${note}` : badge.label,
      dedupeKey: `badge:${badgeId}`,
    });
    await this.audit.record(staff, 'badge.award', { type: holder.role === 'STUDENT' ? 'student' : 'user', id: userId }, { badgeId });
  }

  /** Administrators can take back any badge. A supervisor only those she gave. */
  async revoke(staff: StaffActor, badgeId: string, userId: string): Promise<void> {
    const { count } = await this.prisma.studentBadge.deleteMany({
      where: {
        badgeId,
        studentId: userId,
        ...(isAdministration(staff) ? {} : { awardedById: staff.id, student: { OR: [this.studentsOf(staff), this.staffOf(staff)] } }),
      },
    });
    if (count !== 1) throw notFound();
    const holder = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    await this.audit.record(staff, 'badge.revoke', { type: holder?.role === 'STUDENT' ? 'student' : 'user', id: userId }, { badgeId });
  }

  // ---------- Holding badges ----------

  /** Every badge a user holds, the pinned ones first in the order she pinned them. */
  async held(userId: string) {
    const rows = await this.prisma.studentBadge.findMany({
      where: { studentId: userId },
      orderBy: [{ pinnedAt: { sort: 'asc', nulls: 'last' } }, { awardedAt: 'desc' }],
      select: { awardedAt: true, note: true, pinnedAt: true, badge: { select: LOOK }, awardedBy: { select: { fullName: true } } },
    });
    return rows.map((row) => ({
      ...badgeLook(row.badge),
      awardedAt: row.awardedAt,
      note: row.note,
      awardedBy: row.awardedBy?.fullName ?? null,
      pinned: row.pinnedAt !== null,
    }));
  }

  /**
   * Replaces the badges a holder shows on her profile, in the order given. Each must be one she holds.
   * An empty list unpins them all.
   */
  async setPins(userId: string, badgeIds: string[]): Promise<void> {
    const held = await this.prisma.studentBadge.count({ where: { studentId: userId, badgeId: { in: badgeIds } } });
    if (held !== badgeIds.length) throw notFound();
    const now = Date.now();
    await this.prisma.$transaction([
      this.prisma.studentBadge.updateMany({ where: { studentId: userId, badgeId: { notIn: badgeIds } }, data: { pinnedAt: null } }),
      // A millisecond apart, so the order she chose is the order they show in.
      ...badgeIds.map((badgeId, index) =>
        this.prisma.studentBadge.updateMany({ where: { studentId: userId, badgeId }, data: { pinnedAt: new Date(now + index) } }),
      ),
    ]);
  }

  /**
   * What shows beside each user's name: the badges she pinned or, until she pins any, her three latest.
   * One query for any number of users, so a list can show them all.
   */
  async showcaseOf(userIds: string[]): Promise<Map<string, { pinned: ReturnType<typeof badgeLook>[]; total: number }>> {
    const result = new Map(userIds.map((id) => [id, { pinned: [] as ReturnType<typeof badgeLook>[], total: 0 }]));
    if (userIds.length === 0) return result;
    const rows = await this.prisma.studentBadge.findMany({
      where: { studentId: { in: userIds } },
      orderBy: [{ pinnedAt: { sort: 'asc', nulls: 'last' } }, { awardedAt: 'desc' }],
      select: { studentId: true, pinnedAt: true, badge: { select: LOOK } },
    });
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) byUser.set(row.studentId, [...(byUser.get(row.studentId) ?? []), row]);
    for (const [userId, held] of byUser) {
      const pinned = held.filter((row) => row.pinnedAt !== null);
      result.set(userId, { pinned: (pinned.length > 0 ? pinned : held).slice(0, MAX_PINNED).map((row) => badgeLook(row.badge)), total: held.length });
    }
    return result;
  }

  /**
   * Whose badges a staff member may look at. The administration: everyone. A supervisor: herself, her scope's
   * students and teachers. A teacher: herself, her circles' students, and her scope's supervisors.
   */
  private visibleTo(staff: StaffActor): Prisma.UserWhereInput {
    if (isAdministration(staff)) return {};
    if (staff.role === 'SUPERVISOR') return { OR: [{ id: staff.id }, this.studentsOf(staff), this.staffOf(staff)] };
    return {
      OR: [
        { id: staff.id },
        { role: 'STUDENT', memberships: { some: { leftAt: null, circle: { teacherId: staff.id, archivedAt: null } } } },
        ...(staff.scopeId ? [{ role: 'SUPERVISOR' as const, scopeId: staff.scopeId }] : []),
      ],
    };
  }

  /** The showcase of each listed user the staff member may see. Others are left out. */
  async showcase(staff: StaffActor, userIds: string[]) {
    const visible = await this.prisma.user.findMany({ where: { AND: [{ id: { in: userIds } }, this.visibleTo(staff)] }, select: { id: true } });
    return Object.fromEntries(await this.showcaseOf(visible.map(({ id }) => id)));
  }

  /** All of one user's badges, for her profile page in the dashboard. */
  async profileOf(staff: StaffActor, userId: string) {
    const user = await this.prisma.user.findFirst({ where: { AND: [{ id: userId }, this.visibleTo(staff)] }, select: { id: true } });
    if (!user) throw notFound();
    return this.held(userId);
  }

  /**
   * A student's badges for the app: those she holds, and the active ones she can still earn with how far she
   * is towards each automatic one. Badges for staff only are left out.
   */
  async forStudent(studentId: string) {
    const [badges, earned, metrics] = await Promise.all([
      this.prisma.badge.findMany({
        where: { audience: { in: ['STUDENTS', 'EVERYONE'] }, OR: [{ active: true }, { awards: { some: { studentId } } }] },
        orderBy: { createdAt: 'asc' },
        select: { ...LOOK, code: true },
      }),
      this.prisma.studentBadge.findMany({ where: { studentId }, select: { badgeId: true, awardedAt: true, note: true, pinnedAt: true } }),
      this.plans.badgeMetrics(studentId),
    ]);
    const held = new Map(earned.map((row) => [row.badgeId, row]));
    return badges.map((badge) => {
      const award = held.get(badge.id);
      return {
        ...badgeLook(badge),
        code: badge.code,
        trigger: badge.trigger,
        awardedAt: award?.awardedAt ?? null,
        note: award?.note ?? null,
        pinned: Boolean(award?.pinnedAt),
        progress: award ? null : badgeProgress(badge.trigger, badge.threshold, metrics),
      };
    });
  }
}
