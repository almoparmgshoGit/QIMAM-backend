import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import {
  type AssignStudentDto,
  assignStudentSchema,
  type CreateAnnouncementDto,
  createAnnouncementSchema,
  type CreateCircleDto,
  createCircleSchema,
  type ReorderCirclesDto,
  reorderCirclesSchema,
  type ReorderStudentsDto,
  reorderStudentsSchema,
  type RequestTransferDto,
  requestTransferSchema,
  type UpdateCircleDto,
  updateCircleSchema,
  type UpdateTeacherDto,
  updateTeacherSchema,
} from './supervisor.schemas.js';
import { SupervisorService } from './supervisor.service.js';

@Dashboard()
@Roles('SUPERVISOR')
@Controller('supervisor')
export class SupervisorController {
  constructor(private readonly supervisor: SupervisorService) {}

  @Get('home')
  home(@CurrentStaff() staff: StaffActor) {
    return this.supervisor.home(staff);
  }

  @Get('circles')
  listCircles(@CurrentStaff() staff: StaffActor) {
    return this.supervisor.listCircles(staff);
  }

  @Post('circles')
  createCircle(@CurrentStaff() staff: StaffActor, @Body({ schema: createCircleSchema }) body: CreateCircleDto) {
    return this.supervisor.createCircle(staff, body);
  }

  @Patch('circles/:id')
  @HttpCode(204)
  async updateCircle(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateCircleSchema }) body: UpdateCircleDto,
  ) {
    await this.supervisor.updateCircle(staff, id, body);
  }

  @Delete('circles/:id')
  @HttpCode(204)
  async archiveCircle(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.supervisor.archiveCircle(staff, id);
  }

  @Post('circles/:id/students')
  @HttpCode(204)
  async assignStudent(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: assignStudentSchema }) body: AssignStudentDto,
  ) {
    await this.supervisor.assignStudent(staff, id, body.studentId);
  }

  @Delete('circles/:id/students/:studentId')
  @HttpCode(204)
  async removeStudent(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('studentId', { schema: idSchema }) studentId: string,
  ) {
    await this.supervisor.removeStudent(staff, id, studentId);
  }

  @Put('circles/order')
  @HttpCode(204)
  async reorderCircles(@CurrentStaff() staff: StaffActor, @Body({ schema: reorderCirclesSchema }) body: ReorderCirclesDto) {
    await this.supervisor.reorderCircles(staff, body.circleIds);
  }

  @Put('circles/:id/students/order')
  @HttpCode(204)
  async reorderStudents(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: reorderStudentsSchema }) body: ReorderStudentsDto,
  ) {
    await this.supervisor.reorderStudents(staff, id, body.studentIds);
  }

  @Get('teachers')
  listTeachers(@CurrentStaff() staff: StaffActor) {
    return this.supervisor.listTeachers(staff);
  }

  @Get('teachers/:id')
  teacherDetail(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.supervisor.teacherDetail(staff, id);
  }

  @Patch('teachers/:id')
  @HttpCode(204)
  async updateTeacher(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateTeacherSchema }) body: UpdateTeacherDto,
  ) {
    await this.supervisor.updateTeacher(staff, id, body);
  }

  @Get('teachers/:id/activity')
  teacherActivity(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.supervisor.teacherActivity(staff, id);
  }

  @Get('distribution')
  distribution(@CurrentStaff() staff: StaffActor) {
    return this.supervisor.distribution(staff);
  }

  @Post('transfers')
  requestTransfer(@CurrentStaff() staff: StaffActor, @Body({ schema: requestTransferSchema }) body: RequestTransferDto) {
    return this.supervisor.requestTransfer(staff, body);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(204)
  async cancelTransfer(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.supervisor.cancelTransfer(staff, id);
  }

  @Get('announcements')
  listAnnouncements(@CurrentStaff() staff: StaffActor) {
    return this.supervisor.listAnnouncements(staff);
  }

  @Post('announcements')
  createAnnouncement(@CurrentStaff() staff: StaffActor, @Body({ schema: createAnnouncementSchema }) body: CreateAnnouncementDto) {
    return this.supervisor.createAnnouncement(staff, body);
  }
}
