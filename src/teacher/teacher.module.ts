import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module.js';
import { TeacherProgramController } from './teacher-program.controller.js';
import { TeacherProgramService } from './teacher-program.service.js';
import { TeacherController } from './teacher.controller.js';
import { TeacherService } from './teacher.service.js';

@Module({
  imports: [VoiceModule],
  controllers: [TeacherProgramController, TeacherController],
  exports: [TeacherService],
  providers: [TeacherService, TeacherProgramService],
})
export class TeacherModule {}
