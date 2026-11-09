import { randomBytes } from 'node:crypto';

/** Same length as the 32-character ids Prisma generates, from the same kind of secure random source. */
export const randomId = (): string => randomBytes(24).toString('base64url');
