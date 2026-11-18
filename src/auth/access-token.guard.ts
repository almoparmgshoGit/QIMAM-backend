import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { STAFF_ACCESS_COOKIE } from './staff-cookies.js';
import { ANY_EMPLOYEE, type Permission, PERMISSIONS } from './permissions.js';
import { PERMISSIONS_KEY, ROLES_KEY, type StaffRole } from './staff.decorators.js';
import { TokensService } from './tokens.service.js';

const BEARER = /^Bearer ([A-Za-z0-9_.-]+)$/;

type RoutePermission = Permission | typeof ANY_EMPLOYEE;

/** Drops any key no longer in the catalog, so a stale rank grants nothing it no longer names. */
const grantedPermissions = (stored: string[]) => stored.filter((key): key is Permission => Object.hasOwn(PERMISSIONS, key));

/** An employee passes a route that names one of their permissions, or that any employee may read. */
const employeeMayPass = (granted: Permission[], route: RoutePermission[]) =>
  route.some((permission) => (permission === ANY_EMPLOYEE ? granted.length > 0 : granted.includes(permission)));

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
      const permissions = this.reflector.getAllAndOverride<RoutePermission[] | undefined>(PERMISSIONS_KEY, targets) ?? [];
      await this.authorizeStaff(request, roles, permissions);
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

  private async authorizeStaff(request: AuthenticatedRequest, roles: StaffRole[], routePermissions: RoutePermission[]): Promise<void> {
    // Only an admin's window opened on another account sends a bearer header to the dashboard routes.
    const bearer = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (bearer) {
      await this.authorizeImpersonation(request, roles, bearer);
      return;
    }

    const token = (request.cookies as Record<string, string | undefined>)[STAFF_ACCESS_COOKIE];
    if (!token) throw new ApiError(401, 'invalid_token');

    const userId = await this.tokens.verifyAccessToken(token, 'DASHBOARD');
    // The role and scope come from the database, so a change takes effect at once and no token can claim more.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        scopeId: true,
        staffCredential: { select: { totpEnabledAt: true } },
        rank: { select: { permissions: true } },
      },
    });
    if (user?.status !== 'ACTIVE' || user.role === 'STUDENT') throw new ApiError(401, 'invalid_token');
    // Every role but a teacher signs in with a second step. A token from before a promotion or a
    // credentials reset has not passed it, so it ends here rather than when it expires.
    if (user.role !== 'TEACHER' && !user.staffCredential?.totpEnabledAt) throw new ApiError(401, 'invalid_token');

    // Read with the user on every request, so a change to a rank takes effect at once.
    const granted = user.role === 'EMPLOYEE' ? grantedPermissions(user.rank?.permissions ?? []) : [];
    if (!roles.includes(user.role) && !(user.role === 'EMPLOYEE' && employeeMayPass(granted, routePermissions))) {
      throw new ApiError(403, 'forbidden');
    }

    request.staff = { id: user.id, role: user.role, scopeId: user.scopeId, permissions: granted };
  }

  /**
   * The admin passed their own second step, so the account's own is not asked for. Everything is read again on each
   * request: suspending either account, or the admin signing out, ends the window at once.
   */
  private async authorizeImpersonation(request: AuthenticatedRequest, roles: StaffRole[], token: string): Promise<void> {
    const claims = await this.tokens.verifyImpersonationToken(token);
    const [user, actor, sessionLive] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: claims.userId }, select: { id: true, role: true, status: true, scopeId: true } }),
      this.prisma.user.findUnique({
        where: { id: claims.actorId },
        select: { role: true, status: true, staffCredential: { select: { totpEnabledAt: true } } },
      }),
      this.tokens.isFamilyLive(claims.familyId, claims.actorId),
    ]);
    if (actor?.status !== 'ACTIVE' || actor.role !== 'ADMIN' || !actor.staffCredential?.totpEnabledAt || !sessionLive) {
      throw new ApiError(401, 'invalid_token');
    }
    if (user?.status !== 'ACTIVE' || (user.role !== 'TEACHER' && user.role !== 'SUPERVISOR')) {
      throw new ApiError(401, 'invalid_token');
    }
    if (!roles.includes(user.role)) throw new ApiError(403, 'forbidden');

    request.staff = { id: user.id, role: user.role, scopeId: user.scopeId, permissions: [], impersonatorId: claims.actorId };
  }
}
