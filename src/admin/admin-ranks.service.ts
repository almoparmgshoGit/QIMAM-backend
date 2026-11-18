import { Injectable } from '@nestjs/common';
import { permissionCatalog } from '../auth/permissions.js';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { isUniqueViolation } from '../common/staff-api.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RankDto, UpdateRankDto } from './admin.schemas.js';

const RANK_SELECT = {
  id: true,
  name: true,
  description: true,
  permissions: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { users: true } },
} as const;

type RankRow = {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
  _count: { users: number };
};

const toRank = ({ _count, ...row }: RankRow) => ({ ...row, employees: _count.users });

/**
 * The ranks the administration gives its employees. A change applies to every employee of the rank from their
 * next request, since the permissions are read with the account each time.
 */
@Injectable()
export class AdminRanksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  permissions() {
    return permissionCatalog();
  }

  async list() {
    const rows = await this.prisma.staffRank.findMany({ orderBy: { name: 'asc' }, select: RANK_SELECT });
    return rows.map(toRank);
  }

  async create(admin: StaffActor, dto: RankDto) {
    try {
      const rank = await this.prisma.staffRank.create({
        data: { name: dto.name, description: dto.description ?? null, permissions: dto.permissions },
        select: RANK_SELECT,
      });
      await this.audit.record(admin, 'rank.create', { type: 'rank', id: rank.id }, { permissions: dto.permissions });
      return toRank(rank);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'name_taken');
      throw error;
    }
  }

  async update(admin: StaffActor, rankId: string, dto: UpdateRankDto) {
    await this.rankOrThrow(rankId);
    try {
      const rank = await this.prisma.staffRank.update({ where: { id: rankId }, data: dto, select: RANK_SELECT });
      await this.audit.record(
        admin,
        'rank.update',
        { type: 'rank', id: rankId },
        { renamed: dto.name !== undefined, permissions: dto.permissions ?? null },
      );
      return toRank(rank);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'name_taken');
      throw error;
    }
  }

  /** Only an empty rank goes: its employees are moved to another rank first, so none is left without one. */
  async remove(admin: StaffActor, rankId: string): Promise<void> {
    const rank = await this.rankOrThrow(rankId);
    if (rank._count.users > 0) throw new ApiError(409, 'rank_in_use');
    await this.prisma.staffRank.delete({ where: { id: rankId } });
    await this.audit.record(admin, 'rank.delete', { type: 'rank', id: rankId }, { name: rank.name });
  }

  private async rankOrThrow(rankId: string) {
    const rank = await this.prisma.staffRank.findUnique({ where: { id: rankId }, select: { name: true, _count: { select: { users: true } } } });
    if (!rank) throw new ApiError(404, 'not_found');
    return rank;
  }
}
