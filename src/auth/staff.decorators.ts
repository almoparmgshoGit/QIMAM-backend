import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../generated/prisma/enums.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import type { ANY_EMPLOYEE, Permission } from './permissions.js';

export type StaffRole = Exclude<Role, 'STUDENT'>;

export interface StaffActor {
  id: string;
  role: StaffRole;
  scopeId: string | null;
  /** An employee's permissions, from their rank. Empty for every other role. */
  permissions: Permission[];
  /** Set when an admin is using this account from the dashboard. */
  impersonatorId?: string;
}

export const ROLES_KEY = 'staffRoles';
export const PERMISSIONS_KEY = 'staffPermissions';
export const DASHBOARD_KEY = 'dashboardRoute';

/** Limits a route to these staff roles, signed in through the dashboard's cookies. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Also opens a route to an employee whose rank grants any one of these. A route without it is closed to
 * employees. On a method it replaces the controller's.
 */
export const Permissions = (...permissions: (Permission | typeof ANY_EMPLOYEE)[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Marks a controller as called from the dashboard, so changes must come from an allowed origin. */
export const Dashboard = () => SetMetadata(DASHBOARD_KEY, true);

/** Comes from the verified session, so a route can never act on an identity the client supplied. */
export const CurrentStaff = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthenticatedRequest>().staff,
);

/** Administrators and employees: the administration, which works program-wide and has no scope. */
export const isAdministrationRole = (role: Role) => role === 'ADMIN' || role === 'EMPLOYEE';

/** The administration acting program-wide: an administrator, or an employee a route let through. */
export const isAdministration = (staff: Pick<StaffActor, 'role'>) => isAdministrationRole(staff.role);
