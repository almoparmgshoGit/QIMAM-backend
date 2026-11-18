import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { ApiError } from '../common/api-error.js';
import { TrackChangeService } from '../program/track-change.service.js';
import { SupervisorProgramService } from './supervisor-program.service.js';

const planFilters = z.strictObject({
  circleId: idSchema.optional(),
  teacherId: idSchema.optional(),
  trackId: idSchema.optional(),
});
const reportFilters = z.strictObject({
  circleId: idSchema.optional(),
  teacherId: idSchema.optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
});
const stageFilters = z.strictObject({
  circleId: idSchema.optional(),
  teacherId: idSchema.optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
});
const activityFilters = z.strictObject({ days: z.coerce.number().int().min(1).max(365).default(30) });
const circleTrack = z.strictObject({ trackId: idSchema });

@Dashboard()
@Roles('SUPERVISOR')
@Controller('supervisor')
export class SupervisorProgramController {
  constructor(
    private readonly program: SupervisorProgramService,
    private readonly trackChanges: TrackChangeService,
  ) {}

  /** Track changes asked for in the scope's circles, and who still waits to be placed. */
  @Get('track-changes')
  listTrackChanges(@CurrentStaff() staff: StaffActor) {
    if (!staff.scopeId) throw new ApiError(403, 'no_scope');
    return this.trackChanges.forScope(staff.scopeId);
  }

  @Get('plans')
  planFollowUp(@CurrentStaff() staff: StaffActor, @Query({ schema: planFilters }) query: z.infer<typeof planFilters>) {
    return this.program.planFollowUp(staff, query);
  }

  @Post('students/:id/remind')
  @HttpCode(200)
  remindStudent(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.program.remindStudent(staff, id);
  }

  @Get('templates')
  templates(@CurrentStaff() staff: StaffActor) {
    return this.program.templates(staff);
  }

  @Patch('circles/:id/track')
  @HttpCode(204)
  async setCircleTrack(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: circleTrack }) body: { trackId: string },
  ) {
    await this.program.setCircleTrack(staff, id, body.trackId);
  }

  @Get('reports/stage')
  stageReport(@CurrentStaff() staff: StaffActor, @Query({ schema: stageFilters }) query: z.infer<typeof stageFilters>) {
    return this.program.stageReport(staff, query);
  }

  @Get('reports/gates')
  gateReport(@CurrentStaff() staff: StaffActor, @Query({ schema: reportFilters }) query: z.infer<typeof reportFilters>) {
    return this.program.gateReport(staff, query);
  }

  @Get('reports/activity')
  activityReport(@CurrentStaff() staff: StaffActor, @Query({ schema: activityFilters }) query: z.infer<typeof activityFilters>) {
    return this.program.activityReport(staff, query.days);
  }

  @Get('announcements/incoming')
  incomingAnnouncements(@CurrentStaff() staff: StaffActor) {
    return this.program.incomingAnnouncements(staff);
  }
}
