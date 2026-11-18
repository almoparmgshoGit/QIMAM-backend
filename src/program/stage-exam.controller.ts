import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import type { StageExamMarkKind } from '../generated/prisma/enums.js';
import { type FinalResultInput, ReviewService } from './review.service.js';
import { type ArrangeStageExam, type ExamItemInput, StageExamService } from './stage-exam.service.js';

const listQuerySchema = z.strictObject({ state: z.enum(['OPEN', 'CLOSED']).default('OPEN') });
const arrangeSchema = z.strictObject({
  examinerId: idSchema,
  scheduledAt: z.iso.datetime({ offset: true }).nullable(),
});
const scheduleSchema = z.strictObject({ scheduledAt: z.iso.datetime({ offset: true }) });
const resultSchema = z.strictObject({
  note: z.string().trim().max(500).nullable().default(null),
  /** A review track's final test that passes, when the examiner chooses the main track. */
  moveToTrackId: idSchema.nullable().optional(),
});
const finalRequestSchema = z.strictObject({ kind: z.enum(['RECITATION', 'EXAM']).nullable().default(null) });
const itemSchema = z.strictObject({
  surah: z.number().int().min(1).max(114),
  fromAyah: z.number().int().min(1).max(286),
  toAyah: z.number().int().min(1).max(286),
});
const markSchema = z.strictObject({
  kind: z.enum(['HIFZ', 'PROMPT', 'HESITATION', 'TAJWEED']),
  note: z.string().trim().max(300).nullable().default(null),
});
const bookSchema = z.strictObject({ slotId: idSchema });

/** The supervisor's oversight of stage exams: who examines, and when. */
@Dashboard()
@Roles('SUPERVISOR', 'ADMIN')
@Permissions('stage-exams.manage')
@Controller('stage-exams')
export class StageExamsController {
  constructor(private readonly exams: StageExamService) {}

  @Get()
  list(@CurrentStaff() staff: StaffActor, @Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>) {
    return this.exams.list(staff, query.state);
  }

  /** Teachers this staff member may give an exam to. */
  @Get('examiners')
  examiners(@CurrentStaff() staff: StaffActor) {
    return this.exams.examiners(staff);
  }

  /** The exam's surahs, mistakes and score, as the examiner recorded them. */
  @Get(':id')
  sheet(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.exams.sheet(staff, id);
  }

  @Put(':id/arrangement')
  arrange(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: arrangeSchema }) body: ArrangeStageExam) {
    return this.exams.arrange(staff, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  async cancel(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.exams.cancel(staff, id);
  }
}

/** The examiner's side: the exams given to her, their times, their room and their results. Free times are the admission ones. */
@Dashboard()
@Roles('TEACHER')
@Controller('teacher/stage-exam-sessions')
export class TeacherStageExamsController {
  constructor(
    private readonly exams: StageExamService,
    private readonly review: ReviewService,
  ) {}

  @Get()
  list(@CurrentStaff() staff: StaffActor) {
    return this.exams.examinerList(staff);
  }

  /** The scoring sheet: the surahs heard, their mistakes, and the running score. */
  @Get(':id')
  sheet(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.exams.sheet(staff, id);
  }

  /** For a review track's final test: whether the examiner moves a student who passes, and to which main tracks. */
  @Get(':id/move-options')
  moveOptions(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.review.moveOptions(staff, id);
  }

  @Post(':id/items')
  addItem(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: itemSchema }) body: ExamItemInput) {
    return this.exams.addItem(staff, id, body);
  }

  @Delete(':id/items/:itemId')
  @HttpCode(204)
  async removeItem(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('itemId', { schema: idSchema }) itemId: string,
  ) {
    await this.exams.removeItem(staff, id, itemId);
  }

  @Post(':id/items/:itemId/marks')
  addMark(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('itemId', { schema: idSchema }) itemId: string,
    @Body({ schema: markSchema }) body: { kind: StageExamMarkKind; note: string | null },
  ) {
    return this.exams.addMark(staff, id, itemId, body.kind, body.note);
  }

  @Delete(':id/marks/:markId')
  @HttpCode(204)
  async removeMark(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('markId', { schema: idSchema }) markId: string,
  ) {
    await this.exams.removeMark(staff, id, markId);
  }

  @Patch(':id/schedule')
  schedule(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: scheduleSchema }) body: { scheduledAt: string }) {
    return this.exams.examinerSchedule(staff, id, body.scheduledAt);
  }

  @Post(':id/start')
  @HttpCode(204)
  async start(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.exams.start(staff, id);
  }

  /** A one-time ticket into this exam's voice room, once it has started. */
  @Post(':id/voice-ticket')
  @HttpCode(200)
  voiceTicket(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.exams.voiceTicketForExaminer(staff, id);
  }

  @Post(':id/end')
  @HttpCode(204)
  async end(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.exams.end(staff, id);
  }

  /** Computes and records the result from the mistakes. The score can't be set by hand. */
  @Post(':id/result')
  result(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: resultSchema }) body: FinalResultInput) {
    return this.review.recordResult(staff, id, body);
  }
}

// There is no student id in these routes: a student can only ever reach her own exams.
@Controller('me/stage-exams')
export class StudentStageExamsController {
  constructor(private readonly exams: StageExamService) {}

  @Get()
  get(@CurrentUserId() id: string) {
    return this.exams.forStudent(id);
  }

  @Post(':id/book')
  @HttpCode(200)
  book(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) sessionId: string, @Body({ schema: bookSchema }) body: { slotId: string }) {
    return this.exams.book(id, sessionId, body.slotId);
  }

  @Post(':id/voice-ticket')
  @HttpCode(200)
  voiceTicket(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) sessionId: string) {
    return this.exams.voiceTicketForStudent(id, sessionId);
  }
}

/** A student's review track: where her review stands, and her request for the final recitation or exam. */
@Controller('me/review')
export class StudentReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  get(@CurrentUserId() id: string) {
    return this.review.forStudent(id);
  }

  @Post('final-request')
  @HttpCode(204)
  async request(@CurrentUserId() id: string, @Body({ schema: finalRequestSchema }) body: { kind: 'RECITATION' | 'EXAM' | null }) {
    await this.review.request(id, body.kind);
  }
}
