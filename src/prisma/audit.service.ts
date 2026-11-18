import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** Metadata holds ids and numbers only, never names or phones, so deleting an account leaves nothing identifying. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    actor: StaffActor,
    action: string,
    target: { type: string; id: string },
    metadata?: Prisma.InputJsonObject,
  ): Promise<void> {
    // What an admin does from inside another account is kept as theirs too.
    const fullMetadata = actor.impersonatorId ? { ...metadata, impersonatedBy: actor.impersonatorId } : metadata;
    await this.prisma.auditLog.create({
      data: { actorId: actor.id, actorRole: actor.role, action, targetType: target.type, targetId: target.id, metadata: fullMetadata },
    });
  }
}
