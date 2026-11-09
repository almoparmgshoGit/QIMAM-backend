import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../common/api-error.js';
import { DASHBOARD_KEY } from './staff.decorators.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for the cookie-based dashboard. It adds to SameSite=Strict: a browser always
 * sends Origin on these requests, and a page on another site cannot forge it. A missing Origin is refused too.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowed: Set<string>;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.allowed = new Set(config.getOrThrow<string[]>('ADMIN_ORIGINS'));
  }

  canActivate(context: ExecutionContext): boolean {
    const isDashboard = this.reflector.getAllAndOverride<boolean>(DASHBOARD_KEY, [context.getHandler(), context.getClass()]);
    if (!isDashboard) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    if (!this.allowed.has(request.headers.origin ?? '')) throw new ApiError(403, 'origin_not_allowed');
    return true;
  }
}
