import { Module } from '@nestjs/common';
import { TeacherModule } from '../teacher/teacher.module.js';
import { StudentRecordingsController, SupervisorRecordingsController, TeacherRecordingsController } from './recordings.controller.js';
import { RecordingsService } from './recordings.service.js';

@Module({
  imports: [TeacherModule],
  controllers: [StudentRecordingsController, TeacherRecordingsController, SupervisorRecordingsController],
  providers: [RecordingsService],
})
export class RecordingsModule {}
