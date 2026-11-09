import { Global, Module } from '@nestjs/common';
import { AdmissionService } from './admission.service.js';
import { NotificationsService } from './notifications.service.js';
import { PlanService } from './plan.service.js';
import { AdmissionsController, StaffNotificationsController } from './program.controller.js';
import { SettingsService } from './settings.service.js';

@Global()
@Module({
  controllers: [AdmissionsController, StaffNotificationsController],
  providers: [SettingsService, PlanService, NotificationsService, AdmissionService],
  exports: [SettingsService, PlanService, NotificationsService, AdmissionService],
})
export class ProgramModule {}
