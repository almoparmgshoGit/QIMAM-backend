import { Body, Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { PushService } from '../program/push.service.js';
import {
  type PushDeviceDto,
  pushDeviceSchema,
  type RemovePushDeviceDto,
  removePushDeviceSchema,
  type UpdateProfileDto,
  updateProfileSchema,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

// There is no id in these routes: a student can only ever reach their own record.
@Controller('me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly push: PushService,
  ) {}

  @Get()
  getProfile(@CurrentUserId() userId: string) {
    return this.users.getProfile(userId);
  }

  @Patch()
  updateProfile(@CurrentUserId() userId: string, @Body({ schema: updateProfileSchema }) body: UpdateProfileDto) {
    return this.users.updateProfile(userId, body);
  }

  /** The app calls this at every launch, so a token that changed reaches the server by itself. */
  @Post('push-devices')
  @HttpCode(204)
  async registerPushDevice(@CurrentUserId() userId: string, @Body({ schema: pushDeviceSchema }) body: PushDeviceDto) {
    await this.push.registerDevice(userId, body.pushToken, body.platform === 'ios' ? 'IOS' : 'ANDROID');
  }

  @Post('push-devices/remove')
  @HttpCode(204)
  async removePushDevice(@CurrentUserId() userId: string, @Body({ schema: removePushDeviceSchema }) body: RemovePushDeviceDto) {
    await this.push.removeDevice(userId, body.pushToken);
  }

  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @Delete()
  @HttpCode(204)
  async deleteAccount(@CurrentUserId() userId: string) {
    await this.users.deleteAccount(userId);
  }
}
