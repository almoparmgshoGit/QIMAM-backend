import { Global, Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module.js';
import { AdmissionService } from './admission.service.js';
import { NotificationsService } from './notifications.service.js';
import { PlanService } from './plan.service.js';
import { PushService } from './push.service.js';
import {
  AdmissionsController,
  StaffNotificationsController,
  StudentAdmissionController,
  TeacherAdmissionController,
} from './program.controller.js';
import { SettingsService } from './settings.service.js';
import { ReviewService } from './review.service.js';
import { StageExamsController, StudentReviewController, StudentStageExamsController, TeacherStageExamsController } from './stage-exam.controller.js';
import { StageExamService } from './stage-exam.service.js';
import { TrackChangeService } from './track-change.service.js';

@Global()
@Module({
  imports: [VoiceModule],
  controllers: [
    AdmissionsController,
    TeacherAdmissionController,
    StudentAdmissionController,
    StaffNotificationsController,
    StageExamsController,
    TeacherStageExamsController,
    StudentStageExamsController,
    StudentReviewController,
  ],
  providers: [SettingsService, PlanService, NotificationsService, AdmissionService, PushService, TrackChangeService, StageExamService, ReviewService],
  exports: [SettingsService, PlanService, NotificationsService, AdmissionService, PushService, TrackChangeService, StageExamService, ReviewService],
})
export class ProgramModule {}
