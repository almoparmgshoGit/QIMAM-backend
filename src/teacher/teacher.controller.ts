import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { VoiceService } from '../voice/voice.service.js';
import {
  type AttendanceDto,
  attendanceSchema,
  type AttendanceSheetDto,
  attendanceSheetSchema,
  type CreateRecitationDto,
  createRecitationSchema,
  type CreateSessionDto,
  createSessionSchema,
  type CreateTaskDto,
  createTaskSchema,
  type EvaluateSessionDto,
  evaluateSessionSchema,
  type ListRecitationsDto,
  listRecitationsSchema,
  type ListSessionsDto,
  listSessionsSchema,
  type ListStudentsDto,
  listStudentsSchema,
  type ListTasksDto,
  listTasksSchema,
  type ReportQueryDto,
  reportQuerySchema,
  type SessionNotesDto,
  sessionNotesSchema,
} from './teacher.schemas.js';
import { TeacherService } from './teacher.service.js';

@Dashboard()
@Roles('TEACHER')
@Controller('teacher')
export class TeacherController {
  constructor(
    private readonly teacher: TeacherService,
    private readonly voice: VoiceService,
  ) {}

  @Get('surahs')
  surahs() {
    return this.teacher.surahs();
  }

  @Get('home')
  home(@CurrentStaff() staff: StaffActor) {
    return this.teacher.home(staff);
  }

  @Get('students')
  listStudents(@CurrentStaff() staff: StaffActor, @Query({ schema: listStudentsSchema }) query: ListStudentsDto) {
    return this.teacher.listStudents(staff, query);
  }

  @Get('students/:id')
  studentProfile(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.teacher.studentProfile(staff, id);
  }

  @Get('recitations')
  listRecitations(@CurrentStaff() staff: StaffActor, @Query({ schema: listRecitationsSchema }) query: ListRecitationsDto) {
    return this.teacher.listRecitations(staff, query);
  }

  @Post('recitations')
  createRecitation(@CurrentStaff() staff: StaffActor, @Body({ schema: createRecitationSchema }) body: CreateRecitationDto) {
    return this.teacher.createRecitation(staff, body);
  }

  @Get('attendance')
  attendanceSheet(@CurrentStaff() staff: StaffActor) {
    return this.teacher.attendanceSheet(staff);
  }

  @Post('attendance/sheet')
  @HttpCode(204)
  async saveAttendanceSheet(@CurrentStaff() staff: StaffActor, @Body({ schema: attendanceSheetSchema }) body: AttendanceSheetDto) {
    await this.teacher.saveAttendanceSheet(staff, body);
  }

  @Post('attendance')
  recordAttendance(@CurrentStaff() staff: StaffActor, @Body({ schema: attendanceSchema }) body: AttendanceDto) {
    return this.teacher.recordAttendance(staff, body);
  }

  @Get('tasks')
  listTasks(@CurrentStaff() staff: StaffActor, @Query({ schema: listTasksSchema }) query: ListTasksDto) {
    return this.teacher.listTasks(staff, query);
  }

  @Post('tasks')
  createTask(@CurrentStaff() staff: StaffActor, @Body({ schema: createTaskSchema }) body: CreateTaskDto) {
    return this.teacher.createTask(staff, body);
  }

  @Delete('tasks/:id')
  @HttpCode(204)
  async archiveTask(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.teacher.archiveTask(staff, id);
  }

  @Get('sessions')
  listSessions(@CurrentStaff() staff: StaffActor, @Query({ schema: listSessionsSchema }) query: ListSessionsDto) {
    return this.teacher.listSessions(staff, query);
  }

  @Post('sessions')
  createSession(@CurrentStaff() staff: StaffActor, @Body({ schema: createSessionSchema }) body: CreateSessionDto) {
    return this.teacher.createSession(staff, body);
  }

  @Get('sessions/:id')
  getSession(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.teacher.getSession(staff, id);
  }

  @Post('sessions/:id/start')
  @HttpCode(200)
  startSession(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.teacher.startSession(staff, id);
  }

  /** A one-time ticket into this session's voice room, once it has started. */
  @Post('sessions/:id/voice-ticket')
  @HttpCode(200)
  voiceTicket(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.voice.ticketForTeacher(staff.id, id);
  }

  @Post('sessions/:id/end')
  @HttpCode(200)
  endSession(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.teacher.endSession(staff, id);
  }

  @Post('sessions/:id/cancel')
  @HttpCode(200)
  cancelSession(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.teacher.cancelSession(staff, id);
  }

  @Post('sessions/:id/evaluation')
  evaluateSession(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: evaluateSessionSchema }) body: EvaluateSessionDto,
  ) {
    return this.teacher.evaluateSession(staff, id, body);
  }

  @Post('sessions/:id/notes')
  @HttpCode(200)
  saveSessionNotes(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: sessionNotesSchema }) body: SessionNotesDto,
  ) {
    return this.teacher.saveSessionNotes(staff, id, body.notes);
  }

  @Get('reports')
  report(@CurrentStaff() staff: StaffActor, @Query({ schema: reportQuerySchema }) query: ReportQueryDto) {
    return this.teacher.report(staff, query);
  }

  @Get('transfers')
  listIncomingTransfers(@CurrentStaff() staff: StaffActor) {
    return this.teacher.listIncomingTransfers(staff);
  }

  @Post('transfers/:id/accept')
  @HttpCode(204)
  async acceptTransfer(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.teacher.acceptTransfer(staff, id);
  }

  @Post('transfers/:id/reject')
  @HttpCode(204)
  async rejectTransfer(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.teacher.rejectTransfer(staff, id);
  }
}
