import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import {
  awardBadgeSchema,
  badgeConditionSchema,
  createBadgeSchema,
  type CreateBadgeDto,
  createBroadcastSchema,
  type CreateBroadcastDto,
  createExceptionSchema,
  type CreateExceptionDto,
  createTrackSchema,
  type CreateTrackDto,
  admissionSettingsSchema,
  featureSettingsSchema,
  gateModeSchema,
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
  overview() {
    return this.admin.overview();
  }

  @Get('reports/program')
  programReport(@Query({ schema: reportDaysSchema }) query: z.infer<typeof reportDaysSchema>) {
    return this.admin.programReport(query.days);
  }

  @Get('tracks')
  listTracks() {
    return this.admin.listTracks();
  }

  @Post('tracks')
  createTrack(@CurrentStaff() staff: StaffActor, @Body({ schema: createTrackSchema }) body: CreateTrackDto) {
    return this.admin.createTrack(staff, body);
  }

  @Patch('tracks/:id')
  @HttpCode(204)
  async updateTrack(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateTrackSchema }) body: UpdateTrackDto,
  ) {
    await this.admin.updateTrack(staff, id, body);
  }

  @Get('gate-rules')
  gateRules() {
    return this.admin.gateRules();
  }

  @Put('gate-rules/conditions')
  @HttpCode(204)
  async saveGateConditions(@CurrentStaff() staff: StaffActor, @Body({ schema: gateSettingsSchema }) body: z.infer<typeof gateSettingsSchema>) {
    await this.admin.saveSetting(staff, 'gate', body);
  }

  @Patch('gate-rules/tracks/:id')
  @HttpCode(204)
  async setGateMode(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: gateModeSchema }) body: z.infer<typeof gateModeSchema>,
  ) {
    await this.admin.setGateMode(staff, id, body.mode);
  }

  @Get('gate-exceptions')
  listExceptions() {
    return this.admin.listExceptions();
  }

  @Post('gate-exceptions')
  createException(@CurrentStaff() staff: StaffActor, @Body({ schema: createExceptionSchema }) body: CreateExceptionDto) {
    return this.admin.createException(staff, body);
  }

  @Delete('gate-exceptions/:id')
  @HttpCode(204)
  async removeException(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.removeException(staff, id);
  }

  @Get('tadabbur')
  listTadabbur() {
    return this.admin.listTadabbur();
  }

  @Get('tadabbur/:surah')
  getTadabbur(@Param('surah', { schema: surahParam }) surah: number) {
    return this.admin.getTadabbur(surah);
  }

  @Put('tadabbur/:surah')
  saveTadabbur(
    @CurrentStaff() staff: StaffActor,
    @Param('surah', { schema: surahParam }) surah: number,
    @Body({ schema: tadabburSchema }) body: TadabburDto,
  ) {
    return this.admin.saveTadabbur(staff, surah, body);
  }

  @Get('quran-content')
  quranContent() {
    return this.admin.quranContent();
  }

  @Post('translations')
  @UseInterceptors(translationUpload)
  uploadTranslation(
    @CurrentStaff() staff: StaffActor,
    @Body({ schema: uploadTranslationSchema }) body: UploadTranslationDto,
    @UploadedFile() file: UploadedDoc,
  ) {
    return this.admin.uploadTranslation(staff, body, file);
  }

  @Get('translations/:id/preview')
  previewTranslation(@Param('id', { schema: idSchema }) id: string, @Query({ schema: previewQuerySchema }) query: z.infer<typeof previewQuerySchema>) {
    return this.admin.previewTranslation(id, query.surah, query.ayah);
  }

  @Post('translations/:id/approve')
  @HttpCode(204)
  async approveTranslation(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.decideTranslation(staff, id, true);
  }

  @Post('translations/:id/reject')
  @HttpCode(204)
  async rejectTranslation(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.decideTranslation(staff, id, false);
  }

  @Get('settings')
  settingsOverview() {
    return this.admin.settingsOverview();
  }

  @Put('settings/features')
  @HttpCode(204)
  async saveFeatures(@CurrentStaff() staff: StaffActor, @Body({ schema: featureSettingsSchema }) body: z.infer<typeof featureSettingsSchema>) {
    await this.admin.saveSetting(staff, 'features', body);
  }

  @Put('settings/admission')
  @HttpCode(204)
  async saveAdmission(@CurrentStaff() staff: StaffActor, @Body({ schema: admissionSettingsSchema }) body: z.infer<typeof admissionSettingsSchema>) {
    await this.admin.saveSetting(staff, 'admission', body);
  }

  @Put('settings/permissions')
  @HttpCode(204)
  async savePermissions(@CurrentStaff() staff: StaffActor, @Body({ schema: permissionSettingsSchema }) body: z.infer<typeof permissionSettingsSchema>) {
    await this.admin.saveSetting(staff, 'permissions', body);
  }

  @Put('settings/pledges')
  @HttpCode(204)
  async savePledges(@CurrentStaff() staff: StaffActor, @Body({ schema: pledgesSchema }) body: z.infer<typeof pledgesSchema>) {
    await this.admin.savePledges(staff, body.items);
  }

  @Post('settings/pages')
  createInfoPage(@CurrentStaff() staff: StaffActor, @Body({ schema: infoPageSchema }) body: InfoPageDto) {
    return this.admin.createInfoPage(staff, body);
  }

  @Patch('settings/pages/:slug')
  @HttpCode(204)
  async saveInfoPage(
    @CurrentStaff() staff: StaffActor,
    @Param('slug', { schema: slugParam }) slug: string,
    @Body({ schema: infoPageSchema }) body: InfoPageDto,
  ) {
    await this.admin.saveInfoPage(staff, slug, body);
  }

  @Post('settings/languages/:code')
  @UseInterceptors(languageUpload)
  uploadLanguagePack(
    @CurrentStaff() staff: StaffActor,
    @Param('code', { schema: languageParam }) code: string,
    @UploadedFile() file: UploadedDoc,
  ) {
    return this.admin.uploadLanguagePack(staff, code, file);
  }

  @Get('motivation')
  motivation() {
    return this.admin.motivation();
  }

  @Post('badges')
  createBadge(@CurrentStaff() staff: StaffActor, @Body({ schema: createBadgeSchema }) body: CreateBadgeDto) {
    return this.admin.createBadge(staff, body);
  }

  @Patch('badges/:id')
  @HttpCode(204)
  async setBadgeCondition(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: badgeConditionSchema }) body: z.infer<typeof badgeConditionSchema>,
  ) {
    await this.admin.setBadgeCondition(staff, id, body.condition);
  }

  @Post('students/:id/badges')
  @HttpCode(204)
  async awardBadge(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: awardBadgeSchema }) body: z.infer<typeof awardBadgeSchema>,
  ) {
    await this.admin.awardBadge(staff, id, body.badgeId);
  }

  @Post('encouragement-messages')
  @HttpCode(204)
  async addMessage(@CurrentStaff() staff: StaffActor, @Body({ schema: messageSchema }) body: z.infer<typeof messageSchema>) {
    await this.admin.addMessage(staff, body.text);
  }

  @Delete('encouragement-messages/:id')
  @HttpCode(204)
  async removeMessage(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.removeMessage(staff, id);
  }

  @Post('circles/:id/honor')
  @HttpCode(204)
  async honorCircle(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.honorCircle(staff, id);
  }

  @Get('broadcasts')
  listBroadcasts(@Query({ schema: listBroadcastsSchema }) query: ListBroadcastsDto) {
    return this.admin.listBroadcasts(query);
  }

  @Post('broadcasts')
  createBroadcast(@CurrentStaff() staff: StaffActor, @Body({ schema: createBroadcastSchema }) body: CreateBroadcastDto) {
    return this.admin.createBroadcast(staff, body);
  }

  @Post('broadcasts/:id/end')
  @HttpCode(204)
  async endAnnouncement(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.endAnnouncement(staff, id);
  }

  @Delete('broadcasts/:id')
  @HttpCode(204)
  async deleteAnnouncement(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.deleteAnnouncement(staff, id);
  }
}
