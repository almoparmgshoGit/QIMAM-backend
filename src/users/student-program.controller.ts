import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { idSchema, textField } from '../common/staff-api.js';
import { VoiceService } from '../voice/voice.service.js';
import { StudentProgramService } from './student-program.service.js';
import { StudentViewService } from './student-view.service.js';

const surahParam = z.coerce.number().int().min(1).max(114);
const skipRequestSchema = z.strictObject({
  surah: z.number().int().min(1).max(114).optional(),
  request: textField(200),
  reason: textField(500),
});

const languageCode = z.enum(['ar', 'en']);
// A step's id, which is any non-negative whole number since a track sets its own steps.
const stepParam = z.coerce.number().int().min(0).max(2_147_483_647);
const stepSchema = z.strictObject({ done: z.boolean() });
const dayKindParam = z.enum(['REVIEW', 'WRAP', 'CONSOLIDATION']);
const dayDetailSchema = z.strictObject({ detail: z.string().trim().max(300).optional() });
const reflectionSchema = z.strictObject({ body: textField(4000) });
const achievementsQuery = z.strictObject({ period: z.enum(['week', 'month']).default('week') });
const logQuery = z.strictObject({ period: z.enum(['week', 'month', 'all']).default('week') });

// There is no student id in these routes: a student can only ever reach their own record.
@Controller('me')
export class StudentProgramController {
  constructor(
    private readonly program: StudentProgramService,
    private readonly view: StudentViewService,
    private readonly voice: VoiceService,
  ) {}

  @Get('dashboard')
  dashboard(@CurrentUserId() id: string) {
    return this.view.dashboard(id);
  }

  @Post('wird/steps/:index')
  @HttpCode(204)
  async setStep(
    @CurrentUserId() id: string,
    @Param('index', { schema: stepParam }) index: number,
    @Body({ schema: stepSchema }) body: { done: boolean },
  ) {
    await this.view.setStep(id, index, body.done);
  }

  @Post('wird/repeat')
  @HttpCode(200)
  addRepeat(@CurrentUserId() id: string) {
    return this.view.addCount(id, 'REPEAT');
  }

  @Post('wird/review')
  @HttpCode(200)
  addReview(@CurrentUserId() id: string) {
    return this.view.addCount(id, 'REVIEW');
  }

  @Post('days/:kind/complete')
  @HttpCode(204)
  async completeDay(
    @CurrentUserId() id: string,
    @Param('kind', { schema: dayKindParam }) kind: 'REVIEW' | 'WRAP' | 'CONSOLIDATION',
    @Body({ schema: dayDetailSchema }) body: { detail?: string },
  ) {
    await this.view.completeDay(id, kind, body.detail);
  }

  @Get('reflections/:surah')
  reflection(@CurrentUserId() id: string, @Param('surah', { schema: surahParam }) surah: number) {
    return this.view.reflection(id, surah);
  }

  @Post('reflections/:surah')
  @HttpCode(204)
  async saveReflection(
    @CurrentUserId() id: string,
    @Param('surah', { schema: surahParam }) surah: number,
    @Body({ schema: reflectionSchema }) body: { body: string },
  ) {
    await this.view.saveReflection(id, surah, body.body);
  }

  @Get('achievements')
  achievements(@CurrentUserId() id: string, @Query({ schema: achievementsQuery }) query: { period: 'week' | 'month' }) {
    return this.view.achievements(id, query.period);
  }

  @Get('badge-board')
  badgeBoard(@CurrentUserId() id: string) {
    return this.view.badgeBoard(id);
  }

  @Get('log')
  log(@CurrentUserId() id: string, @Query({ schema: logQuery }) query: { period: 'week' | 'month' | 'all' }) {
    return this.view.log(id, query.period);
  }

  @Get('program')
  getProgram(@CurrentUserId() id: string) {
    return this.program.program(id);
  }

  @Get('review-schedule')
  reviewSchedule(@CurrentUserId() id: string) {
    return this.view.reviewSchedule(id);
  }

  @Post('review-schedule/:evaluationId/done')
  @HttpCode(204)
  async markSegmentReviewed(@CurrentUserId() id: string, @Param('evaluationId', { schema: idSchema }) evaluationId: string) {
    await this.view.markSegmentReviewed(id, evaluationId);
  }

  @Post('wird/complete')
  @HttpCode(204)
  async completeWird(@CurrentUserId() id: string) {
    await this.program.completeWird(id);
  }

  @Post('gates/:surah/tafsir')
  @HttpCode(204)
  async markTafsirRead(@CurrentUserId() id: string, @Param('surah', { schema: surahParam }) surah: number) {
    await this.program.markTafsirRead(id, surah);
  }

  @Post('gates/:surah/lesson')
  @HttpCode(204)
  async markLesson(@CurrentUserId() id: string, @Param('surah', { schema: surahParam }) surah: number) {
    await this.program.markLessonAttended(id, surah);
  }

  @Post('gates/:surah/wrap')
  @HttpCode(200)
  addWrap(@CurrentUserId() id: string, @Param('surah', { schema: surahParam }) surah: number) {
    return this.program.addWrap(id, surah);
  }

  @Get('tadabbur/:surah')
  tadabbur(@CurrentUserId() id: string, @Param('surah', { schema: surahParam }) surah: number) {
    return this.program.tadabbur(id, surah);
  }

  @Post('practical/:taskId')
  @HttpCode(204)
  async completePractical(@CurrentUserId() id: string, @Param('taskId', { schema: idSchema }) taskId: string) {
    await this.program.completePractical(id, taskId);
  }

  @Post('skip-requests')
  createSkipRequest(
    @CurrentUserId() id: string,
    @Body({ schema: skipRequestSchema }) body: { surah?: number; request: string; reason: string },
  ) {
    return this.program.createSkipRequest(id, body);
  }

  @Get('circle')
  circle(@CurrentUserId() id: string) {
    return this.program.circle(id);
  }

  @Post('tasks/:id/complete')
  @HttpCode(204)
  async completeTask(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) taskId: string) {
    await this.program.completeTask(id, taskId);
  }

  /** A one-time ticket into the voice room of the student's own session, once the teacher has started it. */
  @Post('sessions/:id/voice-ticket')
  @HttpCode(200)
  voiceTicket(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) sessionId: string) {
    return this.voice.ticketForStudent(id, sessionId);
  }

  @Get('notifications')
  notifications(@CurrentUserId() id: string) {
    return this.program.notifications(id);
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  async markAllNotificationsRead(@CurrentUserId() id: string) {
    await this.program.markAllNotificationsRead(id);
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  async markNotificationRead(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) notificationId: string) {
    await this.program.markNotificationRead(id, notificationId);
  }

  @Get('announcements')
  announcements(@CurrentUserId() id: string) {
    return this.program.announcements(id);
  }

  @Get('badges')
  badges(@CurrentUserId() id: string) {
    return this.program.badges(id);
  }
}

@Controller()
export class AppConfigController {
  constructor(
    private readonly program: StudentProgramService,
    private readonly view: StudentViewService,
  ) {}

  @Public()
  @Get('app-config')
  appConfig() {
    return this.program.appConfig();
  }

  @Public()
  @Get('language-packs/:code')
  languagePack(@Param('code', { schema: languageCode }) code: string) {
    return this.program.languagePack(code);
  }

  @Public()
  @Get('translations/:id/surahs/:surah')
  translationSurah(@Param('id', { schema: idSchema }) id: string, @Param('surah', { schema: surahParam }) surah: number) {
    return this.program.translationSurah(id, surah);
  }

  /** Before signing up, a student chooses from the tracks open now. */
  @Public()
  @Get('tracks')
  tracks() {
    return this.view.publicTracks();
  }
}
