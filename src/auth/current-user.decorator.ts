import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { StaffActor } from './staff.decorators.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  staff?: StaffActor;
}

/** The id comes from the verified token, so a route can never act on an id the client supplied. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthenticatedRequest>().userId,
);
