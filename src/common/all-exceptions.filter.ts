import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

/** The only way errors leave the API: a stable code and a request id, never a stack or an internal message. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = response.getHeader('X-Request-Id');

    const status = readStatus(exception);
    const body: Record<string, unknown> = { statusCode: status, code: CODE_BY_STATUS[status] ?? 'error', requestId };

    if (exception instanceof HttpException) {
      const detail = exception.getResponse();
      if (typeof detail === 'object') {
        const { code, message, retryAfterSeconds } = detail as Record<string, unknown>;
        if (typeof code === 'string') body.code = code;
        if (typeof retryAfterSeconds === 'number') body.retryAfterSeconds = retryAfterSeconds;
        // Validation messages name the fields that failed, which is what the client needs.
        if (status === 400 && Array.isArray(message)) body.errors = message;
      }
    }

    if (status >= 500) {
      // The URL path and the error only: bodies and headers can hold codes and tokens.
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(`${request.method} ${request.path} requestId=${String(requestId)}`, stack);
    }

    response.status(status).json(body);
  }
}

function readStatus(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  // Errors from the body parser, such as a body over the size limit.
  const status = (exception as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
}
