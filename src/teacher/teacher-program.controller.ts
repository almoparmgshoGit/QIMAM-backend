import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { TrackChangeService } from '../program/track-change.service.js';
import { TeacherProgramService } from './teacher-program.service.js';

const approveGateSchema = z.strictObject({ score: z.number().min(0).max(10).nullable() });
const returnGateSchema = z.strictObject({ note: z.string().trim().max(500).nullable() });
const rewindSchema = z.strictObject({ surah: z.number().int().min(1).max(114) });
const stageExamSchema = z.strictObject({
  studentId: idSchema,
  stage: z.number().int().min(1).max(20),
  score: z.number().min(0).max(10),
});

@Dashboard()
@Roles('TEACHER')
@Controller('teacher')
export class TeacherProgramController {
  constructor(
    private readonly program: TeacherProgramService,
    private readonly trackChanges: TrackChangeService,
  ) {}

  @Get('gates')
  listGates(@CurrentStaff() staff: StaffActor) {
    return this.program.listGates(staff);
  }

  @Post('gates/:id/approve')
  @HttpCode(204)
  async approveGate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: approveGateSchema }) body: { score: number | null },
  ) {
    await this.program.approveGate(staff, id, body.score);
  }

  @Post('gates/:id/return')
  @HttpCode(204)
  async returnGate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: returnGateSchema }) body: { note: string | null },
  ) {
    await this.program.returnGate(staff, id, body.note);
  }

  /** The student declared attending the live lesson, and the teacher knows who was there. */
  @Post('gates/:id/lesson/confirm')
  @HttpCode(204)
  async confirmLesson(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.program.confirmLesson(staff, id);
  }

  @Post('gates/:id/lesson/reject')
  @HttpCode(204)
  async rejectLesson(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.program.rejectLesson(staff, id);
  }

  @Get('skip-requests')
  listSkipRequests(@CurrentStaff() staff: StaffActor) {
    return this.program.listSkipRequests(staff);
  }

  @Post('skip-requests/:id/approve')
  @HttpCode(204)
  async approveSkip(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.program.decideSkipRequest(staff, id, true);
  }

  @Post('skip-requests/:id/reject')
  @HttpCode(204)
  async rejectSkip(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.program.decideSkipRequest(staff, id, false);
  }

  @Get('students/:id/plan-actions')
  planActions(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.program.planActions(staff, id);
  }

  @Post('students/:id/skip-surah')
  @HttpCode(204)
  async skipSurah(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.program.skipSurah(staff, id);
  }

  @Post('students/:id/rewind')
  @HttpCode(204)
  async rewind(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: rewindSchema }) body: { surah: number },
  ) {
    await this.program.rewind(staff, id, body.surah);
  }

  @Get('track-changes')
  listTrackChanges(@CurrentStaff() staff: StaffActor) {
    return this.trackChanges.pendingForTeacher(staff.id);
  }

  @Post('track-changes/:id/approve')
  @HttpCode(204)
  async approveTrackChange(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.trackChanges.decide(staff, id, true);
  }

  @Post('track-changes/:id/reject')
  @HttpCode(204)
  async rejectTrackChange(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.trackChanges.decide(staff, id, false);
  }

  @Get('stage-exams')
  listStageExams(@CurrentStaff() staff: StaffActor) {
    return this.program.listStageExams(staff);
  }

  @Get('announcements')
  announcements(@CurrentStaff() staff: StaffActor) {
    return this.program.announcements(staff);
  }

  @Get('students/:id/record')
  studentRecord(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.program.studentRecord(staff, id);
  }

  @Post('stage-exams')
  recordStageExam(
    @CurrentStaff() staff: StaffActor,
    @Body({ schema: stageExamSchema }) body: { studentId: string; stage: number; score: number },
  ) {
    return this.program.recordStageExam(staff, body);
  }

  @Get('reports/weekly-pages')
  weeklyPages(@CurrentStaff() staff: StaffActor) {
    return this.program.weeklyPages(staff);
  }
}
