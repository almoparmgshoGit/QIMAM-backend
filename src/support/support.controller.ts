import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { SupportHub } from './support-hub.service.js';
import {
  type CreateTicketDto,
  createTicketSchema,
  type MessagesQueryDto,
  messagesQuerySchema,
  type MyTicketsQueryDto,
  myTicketsQuerySchema,
  type SendMessageDto,
  sendMessageSchema,
  type SupportTicketsQueryDto,
  supportTicketsQuerySchema,
  type UpdateTicketDto,
  updateTicketSchema,
} from './support.schemas.js';
import { SupportService } from './support.service.js';

const CREATE_LIMIT = { default: { limit: 10, ttl: 60 * 60_000 } };
const MESSAGE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * A student's own conversations. The dashboard's StaffSupportController has the same routes for teachers and
 * supervisors. There is no requester id in them, so each only ever reaches her own conversations.
 */
@Controller('me/support')
export class StudentSupportController {
  constructor(
    private readonly support: SupportService,
    private readonly hub: SupportHub,
  ) {}

  @Get('tickets')
  list(@CurrentUserId() userId: string, @Query({ schema: myTicketsQuerySchema }) query: MyTicketsQueryDto) {
    return this.support.listMine(userId, query);
  }

  @Get('unread')
  unread(@CurrentUserId() userId: string) {
    return this.support.unreadMine(userId);
  }

  @Post('tickets')
  @Throttle(CREATE_LIMIT)
  create(@CurrentUserId() userId: string, @Body({ schema: createTicketSchema }) body: CreateTicketDto) {
    return this.support.create(userId, body);
  }

  @Get('tickets/:id')
  get(@CurrentUserId() userId: string, @Param('id', { schema: idSchema }) id: string, @Query({ schema: messagesQuerySchema }) query: MessagesQueryDto) {
    return this.support.getMine(userId, id, query);
  }

  @Post('tickets/:id/messages')
  @Throttle(MESSAGE_LIMIT)
  reply(@CurrentUserId() userId: string, @Param('id', { schema: idSchema }) id: string, @Body({ schema: sendMessageSchema }) body: SendMessageDto) {
    return this.support.replyAsRequester(userId, id, body.body);
  }

  @Post('tickets/:id/read')
  @HttpCode(204)
  async read(@CurrentUserId() userId: string, @Param('id', { schema: idSchema }) id: string) {
    await this.support.readMine(userId, id);
  }

  @Post('tickets/:id/close')
  close(@CurrentUserId() userId: string, @Param('id', { schema: idSchema }) id: string) {
    return this.support.closeMine(userId, id);
  }

  /** A one-time ticket for the live updates socket at /v1/support. */
  @Post('socket-ticket')
  socketTicket(@CurrentUserId() userId: string) {
    return this.hub.issue(userId, 'REQUESTER');
  }
}

/** A teacher or supervisor asking the administration for help, from the dashboard. */
@Dashboard()
@Roles('TEACHER', 'SUPERVISOR')
@Controller('staff/support')
export class StaffSupportController {
  constructor(
    private readonly support: SupportService,
    private readonly hub: SupportHub,
  ) {}

  @Get('tickets')
  list(@CurrentStaff() staff: StaffActor, @Query({ schema: myTicketsQuerySchema }) query: MyTicketsQueryDto) {
    return this.support.listMine(staff.id, query);
  }

  @Get('unread')
  unread(@CurrentStaff() staff: StaffActor) {
    return this.support.unreadMine(staff.id);
  }

  @Post('tickets')
  @Throttle(CREATE_LIMIT)
  create(@CurrentStaff() staff: StaffActor, @Body({ schema: createTicketSchema }) body: CreateTicketDto) {
    return this.support.create(staff.id, body);
  }

  @Get('tickets/:id')
  get(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Query({ schema: messagesQuerySchema }) query: MessagesQueryDto) {
    return this.support.getMine(staff.id, id, query);
  }

  @Post('tickets/:id/messages')
  @Throttle(MESSAGE_LIMIT)
  reply(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: sendMessageSchema }) body: SendMessageDto) {
    return this.support.replyAsRequester(staff.id, id, body.body);
  }

  @Post('tickets/:id/read')
  @HttpCode(204)
  async read(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.support.readMine(staff.id, id);
  }

  @Post('tickets/:id/close')
  close(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.support.closeMine(staff.id, id);
  }

  @Post('socket-ticket')
  socketTicket(@CurrentStaff() staff: StaffActor) {
    return this.hub.issue(staff.id, 'REQUESTER');
  }
}

/** The support inbox: every conversation, for administrators and employees whose rank grants support. */
@Dashboard()
@Roles('ADMIN')
@Permissions('support.manage')
@Controller('admin/support')
export class AdminSupportController {
  constructor(
    private readonly support: SupportService,
    private readonly hub: SupportHub,
  ) {}

  @Get('tickets')
  list(@CurrentStaff() staff: StaffActor, @Query({ schema: supportTicketsQuerySchema }) query: SupportTicketsQueryDto) {
    return this.support.list(staff, query);
  }

  @Get('summary')
  summary(@CurrentStaff() staff: StaffActor) {
    return this.support.summary(staff);
  }

  @Get('assignees')
  assignees() {
    return this.support.assignees();
  }

  @Get('tickets/:id')
  get(@Param('id', { schema: idSchema }) id: string, @Query({ schema: messagesQuerySchema }) query: MessagesQueryDto) {
    return this.support.get(id, query);
  }

  @Post('tickets/:id/messages')
  @Throttle(MESSAGE_LIMIT)
  reply(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: sendMessageSchema }) body: SendMessageDto) {
    return this.support.reply(staff, id, body.body);
  }

  @Post('tickets/:id/read')
  @HttpCode(204)
  async read(@Param('id', { schema: idSchema }) id: string) {
    await this.support.read(id);
  }

  @Patch('tickets/:id')
  update(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: updateTicketSchema }) body: UpdateTicketDto) {
    return this.support.update(staff, id, body);
  }

  @Post('socket-ticket')
  socketTicket(@CurrentStaff() staff: StaffActor) {
    return this.hub.issue(staff.id, 'SUPPORT');
  }
}
