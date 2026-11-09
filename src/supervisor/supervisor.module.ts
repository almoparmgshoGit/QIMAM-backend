import { Module } from '@nestjs/common';
import { TeacherModule } from '../teacher/teacher.module.js';
import { SupervisorProgramController } from './supervisor-program.controller.js';
import { SupervisorProgramService } from './supervisor-program.service.js';
import { SupervisorController } from './supervisor.controller.js';
import { SupervisorService } from './supervisor.service.js';

@Module({
  imports: [TeacherModule],
  controllers: [SupervisorProgramController, SupervisorController],
  providers: [SupervisorService, SupervisorProgramService],
  exports: [SupervisorService],
})
export class SupervisorModule {}
