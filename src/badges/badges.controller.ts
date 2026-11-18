import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/public.decorator.js';
import { ANY_EMPLOYEE } from '../auth/permissions.js';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { MAX_BADGE_IMAGE_BYTES } from './badge-image.js';
import {
  type AwardDto,
  awardSchema,
  type AwardsQuery,
  awardsQuerySchema,
  type CreateBadgeDto,
  createBadgeSchema,
  type PinsDto,
  pinsSchema,
  type ShowcaseQuery,
  showcaseQuerySchema,
  type RecipientsQuery,
  recipientsQuerySchema,
  type UpdateBadgeDto,
  updateBadgeSchema,
} from './badges.schemas.js';
import { BadgesService } from './badges.service.js';

// Read in memory and checked completely before it is saved. Never written to disk.
const imageUpload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_BADGE_IMAGE_BYTES, files: 1 } });

/** Creating and shaping badges is for the general administration only. */
@Dashboard()
@Roles('ADMIN')
@Permissions('badges.manage')
@Controller('admin/badges')
export class AdminBadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Get()
  list() {
    return this.badges.list();
  }

  @Post()
  create(@CurrentStaff() staff: StaffActor, @Body({ schema: createBadgeSchema }) body: CreateBadgeDto) {
    return this.badges.create(staff, body);
  }

  @Patch(':id')
  @HttpCode(204)
  async update(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Body({ schema: updateBadgeSchema }) body: UpdateBadgeDto) {
    await this.badges.update(staff, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.badges.remove(staff, id);
  }

  @Put(':id/image')
  @UseInterceptors(imageUpload)
  setImage(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.badges.setImage(staff, id, file);
  }
}

/** Giving badges by hand: administrators to anyone, supervisors within their scope. Every staff member sees her own. */
@Dashboard()
@Permissions('badges.manage')
@Controller('staff/badges')
export class StaffBadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Roles('ADMIN', 'SUPERVISOR')
  @Get('awardable')
  awardable(@CurrentStaff() staff: StaffActor) {
    return this.badges.awardable(staff);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Get('recipients')
  recipients(@CurrentStaff() staff: StaffActor, @Query({ schema: recipientsQuerySchema }) query: RecipientsQuery) {
    return this.badges.recipients(staff, query);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Get('awards')
  awards(@CurrentStaff() staff: StaffActor, @Query({ schema: awardsQuerySchema }) query: AwardsQuery) {
    return this.badges.awards(staff, query);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('awards')
  @HttpCode(204)
  async award(@CurrentStaff() staff: StaffActor, @Body({ schema: awardSchema }) body: AwardDto) {
    await this.badges.award(staff, body);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Delete('awards/:badgeId/:userId')
  @HttpCode(204)
  async revoke(
    @CurrentStaff() staff: StaffActor,
    @Param('badgeId', { schema: idSchema }) badgeId: string,
    @Param('userId', { schema: idSchema }) userId: string,
  ) {
    await this.badges.revoke(staff, badgeId, userId);
  }

  @Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
  @Permissions()
  @Get('mine')
  mine(@CurrentStaff() staff: StaffActor) {
    return this.badges.held(staff.id);
  }

  @Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
  @Permissions()
  @Put('mine/pins')
  @HttpCode(204)
  async pin(@CurrentStaff() staff: StaffActor, @Body({ schema: pinsSchema }) body: PinsDto) {
    await this.badges.setPins(staff.id, body.badgeIds);
  }

  /** The badges beside each name in a list. Users the staff member can't see are left out. */
  @Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
  @Permissions(ANY_EMPLOYEE)
  @Get('showcase')
  showcase(@CurrentStaff() staff: StaffActor, @Query({ schema: showcaseQuerySchema }) query: ShowcaseQuery) {
    return this.badges.showcase(staff, query.ids);
  }

  /** All of one user's badges, for her profile page. */
  @Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
  @Permissions('badges.manage', 'accounts.manage', 'students.manage')
  @Get('of/:userId')
  profileOf(@CurrentStaff() staff: StaffActor, @Param('userId', { schema: idSchema }) userId: string) {
    return this.badges.profileOf(staff, userId);
  }
}

/**
 * Badge pictures are public: they carry nothing private, and the app and the dashboard draw them with plain image
 * tags that send no credentials. The address changes with the picture, so it can be cached for good.
 */
@Controller('badges')
export class BadgeImagesController {
  constructor(private readonly badges: BadgesService) {}

  @Public()
  @Get(':id/image')
  async image(@Param('id', { schema: idSchema }) id: string, @Res({ passthrough: true }) response: Response) {
    const data = await this.badges.image(id);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Helmet allows same-origin only, and the dashboard is on another origin.
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return new StreamableFile(data, { type: 'image/png', length: data.length });
  }
}
