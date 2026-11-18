import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { idSchema, isUniqueViolation, riyadhDate } from '../common/staff-api.js';
import { IsmaService } from './isma.service.js';
import {
  type EvaluateSessionDto,
  evaluateSessionSchema,
  type IsmaAttendanceDto,
  ismaAttendanceSchema,
  type IsmaMarkDto,
  type IsmaMarkNoteDto,
  ismaMarkNoteSchema,
  ismaMarkSchema,
  type IsmaNotifyDto,
  ismaNotifySchema,
  type IsmaOrderDto,
  ismaOrderSchema,
} from './teacher.schemas.js';
import { TeacherService } from './teacher.service.js';

/** حلقة الإسماع, run from inside the session: the queue, the marks, attendance, evaluations and notices. */
@Dashboard()
@Roles('TEACHER')
@Controller('teacher/sessions/:id/isma')
export class IsmaController {
  constructor(
    private readonly isma: IsmaService,
    private readonly teacher: TeacherService,
  ) {}

  @Get()
  room(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.isma.room(staff, id);
  }

  @Put('order')
  @HttpCode(204)
  async reorder(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: ismaOrderSchema }) body: IsmaOrderDto,
  ) {
    await this.isma.reorder(staff, id, body.turnIds);
  }

  @Post('turns/:turnId/activate')
  @HttpCode(204)
  async activate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('turnId', { schema: idSchema }) turnId: string,
  ) {
    await this.isma.activate(staff, id, turnId);
  }

  @Post('turns/:turnId/finish')
  @HttpCode(204)
  async finish(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('turnId', { schema: idSchema }) turnId: string,
  ) {
    await this.isma.finishTurn(staff, id, turnId);
  }

  @Post('turns/:turnId/marks')
  addMark(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('turnId', { schema: idSchema }) turnId: string,
    @Body({ schema: ismaMarkSchema }) body: IsmaMarkDto,
  ) {
    return this.isma.addMark(staff, id, turnId, body.kind);
  }

  @Patch('marks/:markId')
  @HttpCode(204)
  async noteMark(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('markId', { schema: idSchema }) markId: string,
    @Body({ schema: ismaMarkNoteSchema }) body: IsmaMarkNoteDto,
  ) {
    await this.isma.noteMark(staff, id, markId, body.note);
  }

  @Delete('marks/:markId')
  @HttpCode(204)
  async deleteMark(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('markId', { schema: idSchema }) markId: string,
  ) {
    await this.isma.deleteMark(staff, id, markId);
  }

  @Put('turns/:turnId/attendance')
  @HttpCode(204)
  async attendance(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('turnId', { schema: idSchema }) turnId: string,
    @Body({ schema: ismaAttendanceSchema }) body: IsmaAttendanceDto,
  ) {
    const { studentId, circleId, day } = await this.isma.setAttendance(staff, id, turnId, body.attendance);
    await this.teacher.markAttendance(staff, studentId, circleId, body.attendance, riyadhDate(day));
  }

  /** One evaluation per student per session, saved while the session is still running. */
  @Post('turns/:turnId/evaluation')
  async evaluate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('turnId', { schema: idSchema }) turnId: string,
    @Body({ schema: evaluateSessionSchema }) body: EvaluateSessionDto,
  ) {
    const { studentId, circleId, day } = await this.isma.turnForEvaluation(staff, id, turnId);
    try {
      const evaluation = await this.teacher.saveEvaluation(staff, studentId, circleId, body, { liveSessionId: id, day: riyadhDate(day) });
      await this.isma.recordEvaluatedAttendance(turnId, body.attendance);
      return { id: evaluation.id };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'already_evaluated');
      throw error;
    }
  }

  @Post('notify')
  notify(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: ismaNotifySchema }) body: IsmaNotifyDto,
  ) {
    return this.isma.notify(staff, id, body);
  }
}
