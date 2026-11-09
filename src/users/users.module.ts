import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module.js';
import { AppConfigController, StudentProgramController } from './student-program.controller.js';
import { StudentProgramService } from './student-program.service.js';
import { StudentViewService } from './student-view.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [VoiceModule],
  // The program routes first: they are more specific than the profile routes on the same path.
  controllers: [StudentProgramController, AppConfigController, UsersController],
  providers: [UsersService, StudentProgramService, StudentViewService],
})
export class UsersModule {}
