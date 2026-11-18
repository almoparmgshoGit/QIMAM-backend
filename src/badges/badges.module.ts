import { Module } from '@nestjs/common';
import { AdminBadgesController, BadgeImagesController, StaffBadgesController } from './badges.controller.js';
import { BadgesService } from './badges.service.js';

// Prisma, audit, notifications and plans come from global modules.
@Module({
  controllers: [AdminBadgesController, StaffBadgesController, BadgeImagesController],
  providers: [BadgesService],
  exports: [BadgesService],
})
export class BadgesModule {}
