import { HttpException } from '@nestjs/common';

/** An error the client can act on: `code` is stable, and the app turns it into a message. */
export class ApiError extends HttpException {
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super({ code, ...extra }, status);
  }
}
