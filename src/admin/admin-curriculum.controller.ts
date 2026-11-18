import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import { ANY_EMPLOYEE } from '../auth/permissions.js';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import {
  createBroadcastSchema,
  type CreateBroadcastDto,
  createTeacherIncentiveSchema,
  type CreateTeacherIncentiveDto,
  listTeacherIncentivesSchema,
  type ListTeacherIncentivesDto,
  createExceptionSchema,
  type CreateExceptionDto,
  createTrackSchema,
  type CreateTrackDto,
  admissionSettingsSchema,
  featureSettingsSchema,
  gateModeSchema,
  stageExamModeSchema,
  stageExamSettingsSchema,
  gateSettingsSchema,
  infoPageSchema,
  type InfoPageDto,
  languageParam,
  listBroadcastsSchema,
  type ListBroadcastsDto,
  messageSchema,
  permissionSettingsSchema,
  pledgesSchema,
  previewQuerySchema,
  reportDaysSchema,
  slugParam,
  surahParam,
  tadabburSchema,
  type TadabburDto,
  updateTrackSchema,
  type UpdateTrackDto,
  uploadTranslationSchema,
  type UploadTranslationDto,
} from './admin-curriculum.schemas.js';
import { AdminCurriculumService } from './admin-curriculum.service.js';

// Files are read in memory and checked completely before anything is saved. They are never written to disk.
const MB = 1024 * 1024;
const translationUpload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * MB, files: 1 } });
const languageUpload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 2 * MB, files: 1 } });

type UploadedDoc = { originalname: string; buffer: Buffer } | undefined;

@Dashboard()
@Roles('ADMIN')
@Controller('admin')
export class AdminCurriculumController {
  constructor(private readonly admin: AdminCurriculumService) {}

  @Get('overview')
  @Permissions('reports.view', 'students.manage')
  overview() {
    return this.admin.overview();
  }

  @Get('reports/program')
  @Permissions('reports.view')
  programReport(@Query({ schema: reportDaysSchema }) query: z.infer<typeof reportDaysSchema>) {
    return this.admin.programReport(query.days);
  }

  @Get('tracks')
  @Permissions(ANY_EMPLOYEE)
  listTracks() {
    return this.admin.listTracks();
  }

  @Post('tracks')
  @Permissions('tracks.manage')
  createTrack(@CurrentStaff() staff: StaffActor, @Body({ schema: createTrackSchema }) body: CreateTrackDto) {
    return this.admin.createTrack(staff, body);
  }

  @Patch('tracks/:id')
  @Permissions('tracks.manage')
  @HttpCode(204)
  async updateTrack(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateTrackSchema }) body: UpdateTrackDto,
  ) {
    await this.admin.updateTrack(staff, id, body);
  }

  @Get('gate-rules')
  @Permissions('gates.manage')
  gateRules() {
    return this.admin.gateRules();
  }

  @Put('gate-rules/conditions')
  @Permissions('gates.manage')
  @HttpCode(204)
  async saveGateConditions(@CurrentStaff() staff: StaffActor, @Body({ schema: gateSettingsSchema }) body: z.infer<typeof gateSettingsSchema>) {
    await this.admin.saveSetting(staff, 'gate', body);
  }

  @Patch('gate-rules/tracks/:id')
  @Permissions('gates.manage')
  @HttpCode(204)
  async setGateMode(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: gateModeSchema }) body: z.infer<typeof gateModeSchema>,
  ) {
    await this.admin.setGateMode(staff, id, body.mode);
  }

  @Patch('gate-rules/tracks/:id/stage-exam')
  @Permissions('gates.manage')
  @HttpCode(204)
  async setStageExamMode(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: stageExamModeSchema }) body: z.infer<typeof stageExamModeSchema>,
  ) {
    await this.admin.setStageExamMode(staff, id, body.mode);
  }

  @Get('gate-exceptions')
  @Permissions('gates.manage')
  listExceptions() {
    return this.admin.listExceptions();
  }

  @Post('gate-exceptions')
  @Permissions('gates.manage')
  createException(@CurrentStaff() staff: StaffActor, @Body({ schema: createExceptionSchema }) body: CreateExceptionDto) {
    return this.admin.createException(staff, body);
  }

  @Delete('gate-exceptions/:id')
  @Permissions('gates.manage')
  @HttpCode(204)
  async removeException(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.removeException(staff, id);
  }

  @Get('tadabbur')
  @Permissions('content.manage')
  listTadabbur() {
    return this.admin.listTadabbur();
  }

  @Get('tadabbur/:surah')
  @Permissions('content.manage')
  getTadabbur(@Param('surah', { schema: surahParam }) surah: number) {
    return this.admin.getTadabbur(surah);
  }

  @Put('tadabbur/:surah')
  @Permissions('content.manage')
  saveTadabbur(
    @CurrentStaff() staff: StaffActor,
    @Param('surah', { schema: surahParam }) surah: number,
    @Body({ schema: tadabburSchema }) body: TadabburDto,
  ) {
    return this.admin.saveTadabbur(staff, surah, body);
  }

  @Get('quran-content')
  @Permissions('content.manage')
  quranContent() {
    return this.admin.quranContent();
  }

  @Post('translations')
  @Permissions('content.manage')
  @UseInterceptors(translationUpload)
  uploadTranslation(
    @CurrentStaff() staff: StaffActor,
    @Body({ schema: uploadTranslationSchema }) body: UploadTranslationDto,
    @UploadedFile() file: UploadedDoc,
  ) {
    return this.admin.uploadTranslation(staff, body, file);
  }

  @Get('translations/:id/preview')
  @Permissions('content.manage')
  previewTranslation(@Param('id', { schema: idSchema }) id: string, @Query({ schema: previewQuerySchema }) query: z.infer<typeof previewQuerySchema>) {
    return this.admin.previewTranslation(id, query.surah, query.ayah);
  }

  @Post('translations/:id/approve')
  @Permissions('content.manage')
  @HttpCode(204)
  async approveTranslation(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.decideTranslation(staff, id, true);
  }

  @Post('translations/:id/reject')
  @Permissions('content.manage')
  @HttpCode(204)
  async rejectTranslation(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.decideTranslation(staff, id, false);
  }

  @Get('settings')
  @Permissions(ANY_EMPLOYEE)
  settingsOverview() {
    return this.admin.settingsOverview();
  }

  @Put('settings/features')
  @Permissions('settings.manage')
  @HttpCode(204)
  async saveFeatures(@CurrentStaff() staff: StaffActor, @Body({ schema: featureSettingsSchema }) body: z.infer<typeof featureSettingsSchema>) {
    await this.admin.saveSetting(staff, 'features', body);
  }

  @Put('settings/admission')
  @Permissions('settings.manage')
  @HttpCode(204)
  async saveAdmission(@CurrentStaff() staff: StaffActor, @Body({ schema: admissionSettingsSchema }) body: z.infer<typeof admissionSettingsSchema>) {
    await this.admin.saveSetting(staff, 'admission', body);
  }

  @Put('settings/stage-exam')
  @Permissions('settings.manage')
  @HttpCode(204)
  async saveStageExam(@CurrentStaff() staff: StaffActor, @Body({ schema: stageExamSettingsSchema }) body: z.infer<typeof stageExamSettingsSchema>) {
    await this.admin.saveSetting(staff, 'stageExam', body);
  }

  @Put('settings/permissions')
  @Permissions('settings.manage')
  @HttpCode(204)
  async savePermissions(@CurrentStaff() staff: StaffActor, @Body({ schema: permissionSettingsSchema }) body: z.infer<typeof permissionSettingsSchema>) {
    await this.admin.saveSetting(staff, 'permissions', body);
  }

  @Put('settings/pledges')
  @Permissions('settings.manage')
  @HttpCode(204)
  async savePledges(@CurrentStaff() staff: StaffActor, @Body({ schema: pledgesSchema }) body: z.infer<typeof pledgesSchema>) {
    await this.admin.savePledges(staff, body.items);
  }

  @Post('settings/pages')
  @Permissions('settings.manage')
  createInfoPage(@CurrentStaff() staff: StaffActor, @Body({ schema: infoPageSchema }) body: InfoPageDto) {
    return this.admin.createInfoPage(staff, body);
  }

  @Patch('settings/pages/:slug')
  @Permissions('settings.manage')
  @HttpCode(204)
  async saveInfoPage(
    @CurrentStaff() staff: StaffActor,
    @Param('slug', { schema: slugParam }) slug: string,
    @Body({ schema: infoPageSchema }) body: InfoPageDto,
  ) {
    await this.admin.saveInfoPage(staff, slug, body);
  }

  @Post('settings/languages/:code')
  @Permissions('settings.manage')
  @UseInterceptors(languageUpload)
  uploadLanguagePack(
    @CurrentStaff() staff: StaffActor,
    @Param('code', { schema: languageParam }) code: string,
    @UploadedFile() file: UploadedDoc,
  ) {
    return this.admin.uploadLanguagePack(staff, code, file);
  }

  @Get('motivation')
  @Permissions('motivation.manage')
  motivation() {
    return this.admin.motivation();
  }

  // Badges are managed in BadgesModule: /admin/badges and /staff/badges.

  @Post('encouragement-messages')
  @Permissions('motivation.manage')
  @HttpCode(204)
  async addMessage(@CurrentStaff() staff: StaffActor, @Body({ schema: messageSchema }) body: z.infer<typeof messageSchema>) {
    await this.admin.addMessage(staff, body.text);
  }

  @Delete('encouragement-messages/:id')
  @Permissions('motivation.manage')
  @HttpCode(204)
  async removeMessage(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.removeMessage(staff, id);
  }

  @Get('teacher-incentives')
  @Permissions('motivation.manage')
  listTeacherIncentives(@Query({ schema: listTeacherIncentivesSchema }) query: ListTeacherIncentivesDto) {
    return this.admin.listTeacherIncentives(query);
  }

  @Post('teacher-incentives')
  @Permissions('motivation.manage')
  createTeacherIncentive(@CurrentStaff() staff: StaffActor, @Body({ schema: createTeacherIncentiveSchema }) body: CreateTeacherIncentiveDto) {
    return this.admin.createTeacherIncentive(staff, body);
  }

  @Delete('teacher-incentives/:id')
  @Permissions('motivation.manage')
  @HttpCode(204)
  async cancelTeacherIncentive(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.cancelTeacherIncentive(staff, id);
  }

  // Honoring a circle, with its certificates, is in CertificatesModule: /admin/circles/:id/honor.

  @Get('broadcasts')
  @Permissions('announcements.manage')
  listBroadcasts(@Query({ schema: listBroadcastsSchema }) query: ListBroadcastsDto) {
    return this.admin.listBroadcasts(query);
  }

  @Post('broadcasts')
  @Permissions('announcements.manage')
  createBroadcast(@CurrentStaff() staff: StaffActor, @Body({ schema: createBroadcastSchema }) body: CreateBroadcastDto) {
    return this.admin.createBroadcast(staff, body);
  }

  @Post('broadcasts/:id/end')
  @Permissions('announcements.manage')
  @HttpCode(204)
  async endAnnouncement(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.endAnnouncement(staff, id);
  }

  @Delete('broadcasts/:id')
  @Permissions('announcements.manage')
  @HttpCode(204)
  async deleteAnnouncement(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.deleteAnnouncement(staff, id);
  }
}
