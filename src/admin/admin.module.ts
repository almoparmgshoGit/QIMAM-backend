import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SupervisorModule } from '../supervisor/supervisor.module.js';
import { TeacherModule } from '../teacher/teacher.module.js';
import { AdminCurriculumController } from './admin-curriculum.controller.js';
import { AdminCurriculumService } from './admin-curriculum.service.js';
import { AdminRanksController } from './admin-ranks.controller.js';
import { AdminRanksService } from './admin-ranks.service.js';
import { AdminStaffController } from './admin-staff.controller.js';
import { AdminStudentsController } from './admin-students.controller.js';
import { AdminStudentsService } from './admin-students.service.js';
import { AdminStaffService } from './admin-staff.service.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule, SupervisorModule, TeacherModule],
  controllers: [AdminCurriculumController, AdminController, AdminStaffController, AdminStudentsController, AdminRanksController],
  providers: [AdminService, AdminCurriculumService, AdminStaffService, AdminStudentsService, AdminRanksService],
})
export class AdminModule {}
