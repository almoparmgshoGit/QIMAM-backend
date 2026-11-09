import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { type AdmissionDecision, AdmissionService } from './admission.service.js';
import { NotificationsService } from './notifications.service.js';

const decisionSchema = z.strictObject({
  accepted: z.boolean(),
  score: z.number().min(0).max(10).nullable(),
  note: z.string().trim().max(500).nullable(),
});

@Dashboard()
@Roles('SUPERVISOR', 'ADMIN')
@Controller('admissions')
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionService) {}

  @Get()
  list() {
    return this.admissions.list();
  }

  @Post(':id/decision')
  @HttpCode(204)
  async decide(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: decisionSchema }) body: AdmissionDecision,
  ) {
    await this.admissions.decide(staff, id, body);
  }
}

/** The bell in the dashboard. Every query is limited to the signed-in staff member. */
@Dashboard()
@Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
@Controller('staff/notifications')
export class StaffNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentStaff() staff: StaffActor) {
    return this.notifications.inbox(staff.id);
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@CurrentStaff() staff: StaffActor) {
    await this.notifications.markAllRead(staff.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.notifications.markRead(staff.id, id);
  }
}
