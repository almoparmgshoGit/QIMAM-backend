import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SupervisorModule } from '../supervisor/supervisor.module.js';
import { TeacherModule } from '../teacher/teacher.module.js';
import { AdminCurriculumController } from './admin-curriculum.controller.js';
import { AdminCurriculumService } from './admin-curriculum.service.js';
import { AdminStaffController } from './admin-staff.controller.js';
import { AdminStaffService } from './admin-staff.service.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule, SupervisorModule, TeacherModule],
  controllers: [AdminCurriculumController, AdminController, AdminStaffController],
  providers: [AdminService, AdminCurriculumService, AdminStaffService],
})
export class AdminModule {}
