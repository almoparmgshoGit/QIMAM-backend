import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import type { AttendanceStatus } from '../generated/prisma/enums.js';

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

/** A capped page size, so no request can ask for a whole table. */
export const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const pageArgs = ({ page, limit }: { page: number; limit: number }) => ({ skip: (page - 1) * limit, take: limit });

export const textField = (max: number) => z.string().trim().min(1).max(max);

export const phoneField = z
  .string()
  .trim()
  .max(24)
  .transform((value, ctx) => {
    const parsed = parsePhoneNumberFromString(value);
    if (!parsed?.isValid()) {
      ctx.addIssue({ code: 'custom', message: 'invalid phone number' });
      return z.NEVER;
    }
    return parsed.number;
  });

export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** The share of sessions attended. Excused absences don't count either way, and no records means no figure. */
export function attendanceRate(counts: Partial<Record<AttendanceStatus, number>>): number | null {
  const attended = (counts.PRESENT ?? 0) + (counts.LATE ?? 0);
  const total = attended + (counts.ABSENT ?? 0);
  return total === 0 ? null : Math.round((attended / total) * 100);
}

const RIYADH_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' });
const RIYADH_OFFSET = '+03:00';

/** The start of the current day in Riyadh, where the program's days are counted. */
export const riyadhDayStart = (now = new Date()): Date => new Date(`${RIYADH_DAY.format(now)}T00:00:00${RIYADH_OFFSET}`);

/** The current day as a date-only value, for date columns. */
export const riyadhDate = (now = new Date()): Date => new Date(`${RIYADH_DAY.format(now)}T00:00:00Z`);
