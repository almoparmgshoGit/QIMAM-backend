import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { idSchema } from '../common/staff-api.js';
import {
  type EvaluateRecordingDto,
  evaluateRecordingSchema,
  type ListRecordingsDto,
  listRecordingsSchema,
  MAX_RECORDING_BYTES,
  type UploadRecordingDto,
  uploadRecordingSchema,
} from './recordings.schemas.js';
import { RecordingsService } from './recordings.service.js';

// Read in memory and checked before it is saved. Never written to disk.
const audioUpload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_RECORDING_BYTES, files: 1 } });

function sendAudio(response: Response, { mimeType, data }: { mimeType: string; data: Buffer }) {
  // A student's voice: kept by no shared cache.
  response.setHeader('Cache-Control', 'private, no-store');
  return new StreamableFile(data, { type: mimeType, length: data.length });
}

/** A student's own recordings. There is no student id in these routes, so she only ever reaches hers. */
@Controller('me/recordings')
export class StudentRecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  list(@CurrentUserId() id: string) {
    return this.recordings.listMine(id);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  @UseInterceptors(audioUpload)
  upload(
    @CurrentUserId() id: string,
    @Body({ schema: uploadRecordingSchema }) body: UploadRecordingDto,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.recordings.upload(id, body, file);
  }

  @Get(':id/audio')
  async audio(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) recordingId: string, @Res({ passthrough: true }) response: Response) {
    return sendAudio(response, await this.recordings.myAudio(id, recordingId));
  }

  @Delete(':id')
  @HttpCode(204)
  async withdraw(@CurrentUserId() id: string, @Param('id', { schema: idSchema }) recordingId: string) {
    await this.recordings.withdraw(id, recordingId);
  }
}

/** The recordings of the students in the teacher's own circles. */
@Dashboard()
@Roles('TEACHER')
@Controller('teacher/recordings')
export class TeacherRecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  list(@CurrentStaff() staff: StaffActor, @Query({ schema: listRecordingsSchema }) query: ListRecordingsDto) {
    return this.recordings.list(teacherReach(staff), query);
  }

  @Get(':id/audio')
  async audio(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Res({ passthrough: true }) response: Response) {
    return sendAudio(response, await this.recordings.staffAudio(teacherReach(staff), id));
  }

  @Post(':id/evaluation')
  evaluate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: evaluateRecordingSchema }) body: EvaluateRecordingDto,
  ) {
    return this.recordings.evaluate(staff, teacherReach(staff), id, body);
  }
}

/** The recordings of the students in the supervisor's scope: she can hear and evaluate them as their teacher does. */
@Dashboard()
@Roles('SUPERVISOR')
@Controller('supervisor/recordings')
export class SupervisorRecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  list(@CurrentStaff() staff: StaffActor, @Query({ schema: listRecordingsSchema }) query: ListRecordingsDto) {
    return this.recordings.list(scopeReach(staff), query);
  }

  @Get(':id/audio')
  async audio(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string, @Res({ passthrough: true }) response: Response) {
    return sendAudio(response, await this.recordings.staffAudio(scopeReach(staff), id));
  }

  @Post(':id/evaluation')
  evaluate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: evaluateRecordingSchema }) body: EvaluateRecordingDto,
  ) {
    return this.recordings.evaluate(staff, scopeReach(staff), id, body);
  }
}

const teacherReach = (staff: StaffActor) => ({ teacherId: staff.id, archivedAt: null });

function scopeReach(staff: StaffActor) {
  if (!staff.scopeId) throw new ApiError(403, 'no_scope');
  return { scopeId: staff.scopeId, archivedAt: null };
}
