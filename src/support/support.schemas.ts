import { z } from 'zod';
import { idSchema, pageFields, textField } from '../common/staff-api.js';

export const SUPPORT_CATEGORIES = ['TECHNICAL', 'ACCOUNT', 'PROGRAM', 'OTHER'] as const;
export const MAX_MESSAGE_LENGTH = 4000;
/** Conversations a requester may have open at once, so retries can't fill the support inbox. */
export const MAX_OPEN_TICKETS = 5;

const messageBody = textField(MAX_MESSAGE_LENGTH);

export const createTicketSchema = z.strictObject({
  subject: textField(160),
  category: z.enum(SUPPORT_CATEGORIES).default('OTHER'),
  body: messageBody,
});
export type CreateTicketDto = z.infer<typeof createTicketSchema>;

export const sendMessageSchema = z.strictObject({ body: messageBody });
export type SendMessageDto = z.infer<typeof sendMessageSchema>;

/** Older messages than the given one: the conversation is read from the newest back. */
export const messagesQuerySchema = z.strictObject({
  before: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessagesQueryDto = z.infer<typeof messagesQuerySchema>;

export const myTicketsQuerySchema = z.strictObject({
  ...pageFields,
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});
export type MyTicketsQueryDto = z.infer<typeof myTicketsQuerySchema>;

export const supportTicketsQuerySchema = z.strictObject({
  ...pageFields,
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  /** "me": assigned to the caller. "none": waiting for someone to take it. */
  assigned: z.enum(['me', 'none']).optional(),
  category: z.enum(SUPPORT_CATEGORIES).optional(),
  requesterRole: z.enum(['STUDENT', 'TEACHER', 'SUPERVISOR']).optional(),
  /** Only those with messages support has not read. */
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type SupportTicketsQueryDto = z.infer<typeof supportTicketsQuerySchema>;

export const updateTicketSchema = z
  .strictObject({
    status: z.enum(['OPEN', 'CLOSED']).optional(),
    assigneeId: idSchema.nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.assigneeId !== undefined, { message: 'nothing to change' });
export type UpdateTicketDto = z.infer<typeof updateTicketSchema>;
