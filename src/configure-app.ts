import { randomUUID } from 'node:crypto';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

/** Shared by the server and the end-to-end tests, so the tests exercise the real protections. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  const trustProxy = config.get<string>('TRUST_PROXY', 'false');
  if (trustProxy !== 'false') app.set('trust proxy', trustProxy);

  app.use(helmet());
  // Only the dashboard's own origins, never a wildcard. The mobile app doesn't use CORS.
  app.enableCors({
    origin: config.getOrThrow<string[]>('ADMIN_ORIGINS'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type'],
  });
  app.use((_request: Request, response: Response, next: NextFunction) => {
    // Generated here, never taken from the client, so it cannot inject into the logs.
    response.setHeader('X-Request-Id', randomUUID());
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());
  // JSON only, with a size limit. Any other content type leaves no body, and validation rejects it.
  app.useBodyParser('json', { limit: '100kb', type: 'application/json' });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
}
