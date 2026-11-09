import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../generated/prisma/enums.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';

export type StaffRole = Exclude<Role, 'STUDENT'>;

export interface StaffActor {
  id: string;
  role: StaffRole;
  scopeId: string | null;
}

export const ROLES_KEY = 'staffRoles';
export const DASHBOARD_KEY = 'dashboardRoute';

/** Limits a route to these staff roles, signed in through the dashboard's cookies. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/** Marks a controller as called from the dashboard, so changes must come from an allowed origin. */
export const Dashboard = () => SetMetadata(DASHBOARD_KEY, true);

/** Comes from the verified session, so a route can never act on an identity the client supplied. */
export const CurrentStaff = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthenticatedRequest>().staff,
);
