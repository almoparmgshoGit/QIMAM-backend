import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { pageArgs } from '../common/staff-api.js';
import { supportNewKey, supportReplyKey } from '../common/support-keys.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { SupportHub } from './support-hub.service.js';
import {
  type CreateTicketDto,
  MAX_OPEN_TICKETS,
  type MessagesQueryDto,
  type MyTicketsQueryDto,
  type SupportTicketsQueryDto,
  type UpdateTicketDto,
} from './support.schemas.js';

const PREVIEW_LENGTH = 140;

/** Who answers support: every administrator, and each employee whose rank grants it. */
export const SUPPORT_STAFF = {
  status: 'ACTIVE',
  OR: [{ role: 'ADMIN' }, { role: 'EMPLOYEE', rank: { permissions: { has: 'support.manage' } } }],
} satisfies Prisma.UserWhereInput;

const ticketSelect = {
  id: true,
  subject: true,
  category: true,
  status: true,
  requesterUnread: true,
  supportUnread: true,
  lastMessageAt: true,
  closedAt: true,
  createdAt: true,
  requester: { select: { id: true, fullName: true, role: true } },
  assignee: { select: { id: true, fullName: true } },
  messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { body: true, fromSupport: true, createdAt: true } },
} satisfies Prisma.SupportTicketSelect;

const messageSelect = {
  id: true,
  body: true,
  fromSupport: true,
  createdAt: true,
  author: { select: { id: true, fullName: true } },
} satisfies Prisma.SupportMessageSelect;

type TicketRow = Prisma.SupportTicketGetPayload<{ select: typeof ticketSelect }>;
type MessageRow = Prisma.SupportMessageGetPayload<{ select: typeof messageSelect }>;

const preview = (row: TicketRow) => {
  const last = row.messages[0];
  return last ? { body: last.body.slice(0, PREVIEW_LENGTH), fromSupport: last.fromSupport, createdAt: last.createdAt } : null;
};

const common = (row: TicketRow) => ({
  id: row.id,
  subject: row.subject,
  category: row.category,
  status: row.status,
  lastMessageAt: row.lastMessageAt,
  closedAt: row.closedAt,
  createdAt: row.createdAt,
  lastMessage: preview(row),
});

/** The requester never learns which staff member answered, only that support did. */
const toRequesterTicket = (row: TicketRow) => ({ ...common(row), unread: row.requesterUnread });
const toRequesterMessage = ({ id, body, fromSupport, createdAt }: MessageRow) => ({ id, body, fromSupport, createdAt });

const toSupportTicket = (row: TicketRow) => ({
  ...common(row),
  unread: row.supportUnread,
  requester: row.requester,
  assignee: row.assignee,
});
const toSupportMessage = ({ id, body, fromSupport, createdAt, author }: MessageRow) => ({ id, body, fromSupport, createdAt, author });

/**
 * Support conversations. Each one is between one requester (a student, teacher or supervisor) and the support
 * side as a whole: any support staff member may read and answer, and one may take it on as its assignee.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: SupportHub,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ---------- The requester's side ----------

  async listMine(userId: string, { status, ...page }: MyTicketsQueryDto) {
    const where = { requesterId: userId, ...(status && { status }) };
    const [total, unread, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.count({ where: { requesterId: userId, requesterUnread: { gt: 0 } } }),
      this.prisma.supportTicket.findMany({ where, orderBy: { lastMessageAt: 'desc' }, select: ticketSelect, ...pageArgs(page) }),
    ]);
    return { total, unread, items: rows.map(toRequesterTicket) };
  }

  /** How many of the requester's conversations have a reply she hasn't read, for a badge. */
  async unreadMine(userId: string) {
    return { unread: await this.prisma.supportTicket.count({ where: { requesterId: userId, requesterUnread: { gt: 0 } } }) };
  }

  async create(userId: string, { subject, category, body }: CreateTicketDto) {
    const open = await this.prisma.supportTicket.count({ where: { requesterId: userId, status: 'OPEN' } });
    if (open >= MAX_OPEN_TICKETS) throw new ApiError(409, 'too_many_open_tickets', { limit: MAX_OPEN_TICKETS });

    const created = await this.prisma.supportTicket.create({
      data: {
        requesterId: userId,
        subject,
        category,
        supportUnread: 1,
        messages: { create: { authorId: userId, fromSupport: false, body } },
      },
      select: { id: true, messages: { select: messageSelect } },
    });
    const row = await this.ticketRow(created.id);
    this.hub.toSupport({ type: 'ticket', ticket: toSupportTicket(row) });
    this.hub.toRequester(userId, { type: 'ticket', ticket: toRequesterTicket(row) });

    // Not awaited: telling the staff must not hold up the request.
    void this.notifySupportOfNewTicket(row).catch(() => undefined);
    return { ticket: toRequesterTicket(row), messages: created.messages.map(toRequesterMessage) };
  }

  async getMine(userId: string, id: string, query: MessagesQueryDto) {
    const row = await this.prisma.supportTicket.findFirst({ where: { id, requesterId: userId }, select: ticketSelect });
    if (!row) throw new ApiError(404, 'not_found');
    const { messages, hasMore } = await this.messages(id, query);
    return { ticket: toRequesterTicket(row), messages: messages.map(toRequesterMessage), hasMore };
  }

  /** A message on a closed conversation opens it again, so the requester never has to start over. */
  async replyAsRequester(userId: string, id: string, body: string) {
    await this.ownTicket(userId, id);
    const now = new Date();
    const [message] = await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: id, authorId: userId, fromSupport: false, body, createdAt: now }, select: messageSelect }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { status: 'OPEN', closedAt: null, lastMessageAt: now, requesterUnread: 0, supportUnread: { increment: 1 } },
      }),
    ]);
    await this.announce(id, message);
    return toRequesterMessage(message);
  }

  async readMine(userId: string, id: string): Promise<void> {
    await this.ownTicket(userId, id);
    // Only a change is announced, so opening a read conversation tells no one anything.
    const { count } = await this.prisma.supportTicket.updateMany({ where: { id, requesterUnread: { gt: 0 } }, data: { requesterUnread: 0 } });
    if (count > 0) await this.announce(id);
  }

  async closeMine(userId: string, id: string) {
    await this.ownTicket(userId, id);
    await this.prisma.supportTicket.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } });
    const row = await this.announce(id);
    return toRequesterTicket(row);
  }

  // ---------- The support side ----------

  async list(staff: StaffActor, { status, assigned, category, requesterRole, unread, q, ...page }: SupportTicketsQueryDto) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(status && { status }),
      ...(category && { category }),
      ...(assigned === 'me' && { assigneeId: staff.id }),
      ...(assigned === 'none' && { assigneeId: null }),
      ...(unread !== undefined && { supportUnread: unread ? { gt: 0 } : 0 }),
      ...(requesterRole && { requester: { role: requesterRole } }),
      // By the requester's name or the subject.
      ...(q && {
        OR: [{ subject: { contains: q, mode: 'insensitive' } }, { requester: { fullName: { contains: q, mode: 'insensitive' } } }],
      }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        // Those waiting on support come first, then the most recent.
        orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
        select: ticketSelect,
        ...pageArgs(page),
      }),
    ]);
    return { total, items: rows.map(toSupportTicket) };
  }

  /** The counts behind the dashboard's badge and the inbox's tabs. */
  async summary(staff: StaffActor) {
    const [open, unread, unassigned, mine] = await Promise.all([
      this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      this.prisma.supportTicket.count({ where: { supportUnread: { gt: 0 } } }),
      this.prisma.supportTicket.count({ where: { status: 'OPEN', assigneeId: null } }),
      this.prisma.supportTicket.count({ where: { status: 'OPEN', assigneeId: staff.id } }),
    ]);
    return { open, unread, unassigned, mine };
  }

  async get(id: string, query: MessagesQueryDto) {
    const row = await this.prisma.supportTicket.findUnique({ where: { id }, select: ticketSelect });
    if (!row) throw new ApiError(404, 'not_found');
    const { messages, hasMore } = await this.messages(id, query);
    return { ticket: toSupportTicket(row), messages: messages.map(toSupportMessage), hasMore };
  }

  /** Answering takes on an unassigned conversation, and opens a closed one again. */
  async reply(staff: StaffActor, id: string, body: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id }, select: { assigneeId: true, requesterUnread: true } });
    if (!ticket) throw new ApiError(404, 'not_found');
    const now = new Date();
    const [message] = await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: id, authorId: staff.id, fromSupport: true, body, createdAt: now }, select: messageSelect }),
      this.prisma.supportTicket.update({
        where: { id },
        data: {
          status: 'OPEN',
          closedAt: null,
          lastMessageAt: now,
          supportUnread: 0,
          requesterUnread: { increment: 1 },
          ...(!ticket.assigneeId && { assigneeId: staff.id }),
        },
      }),
    ]);
    const row = await this.announce(id, message);
    // Only the first reply she hasn't read yet notifies her: a burst of messages is one notification.
    if (ticket.requesterUnread === 0) {
      void this.notifications
        .send([row.requester.id], {
          type: 'GENERAL',
          title: 'ردّ الدعم الفني على رسالتك',
          body: row.subject,
          dedupeKey: supportReplyKey(id, message.id),
        })
        .catch(() => undefined);
    }
    return toSupportMessage(message);
  }

  async read(id: string): Promise<void> {
    const { count } = await this.prisma.supportTicket.updateMany({ where: { id, supportUnread: { gt: 0 } }, data: { supportUnread: 0 } });
    if (count > 0) return this.announce(id).then(() => undefined);
    const exists = await this.prisma.supportTicket.count({ where: { id } });
    if (exists === 0) throw new ApiError(404, 'not_found');
  }

  async update(staff: StaffActor, id: string, { status, assigneeId }: UpdateTicketDto) {
    const existing = await this.prisma.supportTicket.findUnique({ where: { id }, select: { status: true, assigneeId: true } });
    if (!existing) throw new ApiError(404, 'not_found');
    if (assigneeId) {
      const assignee = await this.prisma.user.findFirst({ where: { id: assigneeId, ...SUPPORT_STAFF }, select: { id: true } });
      if (!assignee) throw new ApiError(422, 'invalid_assignee');
    }
    await this.prisma.supportTicket.update({
      where: { id },
      data: {
        ...(assigneeId !== undefined && { assigneeId }),
        ...(status && status !== existing.status && { status, closedAt: status === 'CLOSED' ? new Date() : null }),
      },
    });
    await this.audit.record(staff, 'support.update', { type: 'support_ticket', id }, {
      ...(status !== undefined && { status }),
      ...(assigneeId !== undefined && { assigneeId }),
    });
    return toSupportTicket(await this.announce(id));
  }

  /** Whom a conversation may be assigned to. */
  async assignees() {
    return this.prisma.user.findMany({ where: SUPPORT_STAFF, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, role: true } });
  }

  // ---------- Shared ----------

  /** Whether someone connected may still listen: a suspended account, or one taken off support, may not. */
  async allowedListeners(members: { userId: string; side: 'REQUESTER' | 'SUPPORT' }[]): Promise<Set<string>> {
    if (members.length === 0) return new Set();
    const ids = [...new Set(members.map(({ userId }) => userId))];
    const [requesters, support] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE', role: { in: ['STUDENT', 'TEACHER', 'SUPERVISOR'] } }, select: { id: true } }),
      this.prisma.user.findMany({ where: { id: { in: ids }, ...SUPPORT_STAFF }, select: { id: true } }),
    ]);
    const allowed = new Set<string>();
    for (const { id } of requesters) allowed.add(`REQUESTER:${id}`);
    for (const { id } of support) allowed.add(`SUPPORT:${id}`);
    return allowed;
  }

  private async ownTicket(userId: string, id: string): Promise<void> {
    const found = await this.prisma.supportTicket.findFirst({ where: { id, requesterId: userId }, select: { id: true } });
    if (!found) throw new ApiError(404, 'not_found');
  }

  private ticketRow(id: string): Promise<TicketRow> {
    return this.prisma.supportTicket.findUniqueOrThrow({ where: { id }, select: ticketSelect });
  }

  /** Tells both sides, live, what changed: each sees the conversation as its own side does. */
  private async announce(id: string, message?: MessageRow): Promise<TicketRow> {
    const row = await this.ticketRow(id);
    if (message) {
      this.hub.toRequester(row.requester.id, { type: 'message', ticketId: id, message: toRequesterMessage(message) });
      this.hub.toSupport({ type: 'message', ticketId: id, message: toSupportMessage(message) });
    }
    this.hub.toRequester(row.requester.id, { type: 'ticket', ticket: toRequesterTicket(row) });
    this.hub.toSupport({ type: 'ticket', ticket: toSupportTicket(row) });
    return row;
  }

  private async messages(ticketId: string, { before, limit }: MessagesQueryDto) {
    const rows = await this.prisma.supportMessage.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(before && { cursor: { id: before }, skip: 1 }),
      take: limit + 1,
      select: messageSelect,
    });
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasMore };
  }

  private async notifySupportOfNewTicket(row: TicketRow): Promise<void> {
    const staff = await this.prisma.user.findMany({ where: SUPPORT_STAFF, select: { id: true } });
    await this.notifications.send(
      staff.map(({ id }) => id),
      { type: 'GENERAL', title: 'محادثة دعم فني جديدة', body: `${row.requester.fullName} · ${row.subject}`, dedupeKey: supportNewKey(row.id) },
    );
  }
}
