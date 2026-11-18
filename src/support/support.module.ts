import { Module } from '@nestjs/common';
import { SupportHub } from './support-hub.service.js';
import { AdminSupportController, StaffSupportController, StudentSupportController } from './support.controller.js';
import { SupportGateway } from './support.gateway.js';
import { SupportService } from './support.service.js';

@Module({
  controllers: [StudentSupportController, StaffSupportController, AdminSupportController],
  providers: [SupportHub, SupportService, SupportGateway],
})
export class SupportModule {}
