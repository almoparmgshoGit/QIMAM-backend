import { Body, Controller, Delete, Get, HttpCode, Patch } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { type UpdateProfileDto, updateProfileSchema } from './users.schemas.js';
import { UsersService } from './users.service.js';

// There is no id in these routes: a student can only ever reach their own record.
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  getProfile(@CurrentUserId() userId: string) {
    return this.users.getProfile(userId);
  }

  @Patch()
  updateProfile(@CurrentUserId() userId: string, @Body({ schema: updateProfileSchema }) body: UpdateProfileDto) {
    return this.users.updateProfile(userId, body);
  }

  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @Delete()
  @HttpCode(204)
  async deleteAccount(@CurrentUserId() userId: string) {
    await this.users.deleteAccount(userId);
  }
}
