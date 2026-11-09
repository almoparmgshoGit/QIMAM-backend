import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { STAFF_ACCESS_COOKIE } from './staff-cookies.js';
import { ROLES_KEY, type StaffRole } from './staff.decorators.js';
import { TokensService } from './tokens.service.js';

const BEARER = /^Bearer ([A-Za-z0-9_.-]+)$/;

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, targets);
    if (roles) {
      await this.authorizeStaff(request, roles);
    } else {
      await this.authorizeStudent(request);
    }
    return true;
  }

  private async authorizeStudent(request: AuthenticatedRequest): Promise<void> {
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new ApiError(401, 'invalid_token');

    const userId = await this.tokens.verifyAccessToken(token);
    // Read on every request, so suspending or deleting an account takes effect at once.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
    if (user?.status !== 'ACTIVE' || user.role !== 'STUDENT') throw new ApiError(401, 'invalid_token');

    request.userId = userId;
  }

  private async authorizeStaff(request: AuthenticatedRequest, roles: StaffRole[]): Promise<void> {
    const token = (request.cookies as Record<string, string | undefined>)[STAFF_ACCESS_COOKIE];
    if (!token) throw new ApiError(401, 'invalid_token');

    const userId = await this.tokens.verifyAccessToken(token, 'DASHBOARD');
    // The role and scope come from the database, so a change takes effect at once and no token can claim more.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true, scopeId: true },
    });
    if (user?.status !== 'ACTIVE' || user.role === 'STUDENT') throw new ApiError(401, 'invalid_token');
    if (!roles.includes(user.role)) throw new ApiError(403, 'forbidden');

    request.staff = { id: user.id, role: user.role, scopeId: user.scopeId };
  }
}
