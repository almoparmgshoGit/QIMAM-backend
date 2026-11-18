import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { type AdmissionDecision, AdmissionService, type AssignTest } from './admission.service.js';
import { NotificationsService } from './notifications.service.js';

const decisionSchema = z.strictObject({
  accepted: z.boolean(),
  score: z.number().min(0).max(10).nullable(),
  note: z.string().trim().max(500).nullable(),
  /** The track the tester chooses on acceptance. Left out, the student chooses it in the app. */
  trackId: idSchema.nullable().optional(),
  trackStart: z.enum(['KAHF', 'FATIHA']).nullable().optional(),
});

const assignSchema = z.strictObject({
  teacherId: idSchema,
  scheduledAt: z.iso.datetime({ offset: true }).nullable(),
});

const slotSchema = z.strictObject({ startsAt: z.iso.datetime({ offset: true }) });
const bookSchema = z.strictObject({ slotId: idSchema });

@Dashboard()
@Roles('SUPERVISOR', 'ADMIN')
@Permissions('admissions.manage')
@Controller('admissions')
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionService) {}

  @Get()
  list() {
    return this.admissions.list();
  }

  /** Tracks a student may be put on when accepted. */
  @Get('tracks')
  tracks() {
    return this.admissions.tracks();
  }

  /** Teachers this staff member may give a test to. */
  @Get('teachers')
  teachers(@CurrentStaff() staff: StaffActor) {
    return this.admissions.teachers(staff);
  }

  @Put(':id/test')
  assign(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: assignSchema }) body: AssignTest,
  ) {
    return this.admissions.assign(staff, id, body);
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

/** The teacher's side of admission tests: her free times, the tests given to her, and their room. */
@Dashboard()
@Roles('TEACHER')
@Controller('teacher/admission')
export class TeacherAdmissionController {
  constructor(private readonly admissions: AdmissionService) {}

  @Get('tests')
  tests(@CurrentStaff() staff: StaffActor) {
    return this.admissions.teacherTests(staff);
  }

  /** Tracks the teacher may put a student on when accepting her. */
  @Get('tracks')
  tracks() {
    return this.admissions.tracks();
  }

  @Post('tests/:id/start')
  @HttpCode(204)
  async start(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admissions.start(staff, id);
  }

  /** A one-time ticket into this test's voice room, once it has started. */
  @Post('tests/:id/voice-ticket')
  @HttpCode(200)
  voiceTicket(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.admissions.voiceTicketForTeacher(staff, id);
  }

  @Post('tests/:id/end')
  @HttpCode(204)
  async end(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admissions.end(staff, id);
  }

  @Post('tests/:id/decision')
  @HttpCode(204)
  async decide(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: decisionSchema }) body: AdmissionDecision,
  ) {
    await this.admissions.teacherDecide(staff, id, body);
  }

  @Get('slots')
  slots(@CurrentStaff() staff: StaffActor) {
    return this.admissions.slots(staff);
  }

  @Post('slots')
  addSlot(@CurrentStaff() staff: StaffActor, @Body({ schema: slotSchema }) body: { startsAt: string }) {
    return this.admissions.addSlot(staff, body.startsAt);
  }

  @Delete('slots/:id')
  @HttpCode(204)
  async removeSlot(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admissions.removeSlot(staff, id);
  }
}

// There is no student id in these routes: a student can only ever reach her own test.
@Controller('me/admission')
export class StudentAdmissionController {
  constructor(private readonly admissions: AdmissionService) {}

  @Get()
  get(@CurrentUserId() id: string) {
    return this.admissions.forStudent(id);
  }

  @Post('book')
  @HttpCode(200)
  book(@CurrentUserId() id: string, @Body({ schema: bookSchema }) body: { slotId: string }) {
    return this.admissions.book(id, body.slotId);
  }

  @Post('tests/:id/voice-ticket')
  @HttpCode(200)
  voiceTicket(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) testId: string) {
    return this.admissions.voiceTicketForStudent(id, testId);
  }
}

/** The bell in the dashboard. Every query is limited to the signed-in staff member. */
@Dashboard()
@Roles('TEACHER', 'SUPERVISOR', 'ADMIN', 'EMPLOYEE')
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
