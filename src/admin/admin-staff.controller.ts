import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import {
  type AssignStudentDto,
  assignStudentSchema,
  type RequestTransferDto,
  requestTransferSchema,
} from '../supervisor/supervisor.schemas.js';
import { AdminStaffService } from './admin-staff.service.js';
import { type MoveTeacherDto, moveTeacherSchema, type UpdateAdminCircleDto, updateCircleSchema } from './admin.schemas.js';

@Dashboard()
@Roles('ADMIN')
@Permissions('accounts.manage')
@Controller('admin')
export class AdminStaffController {
  constructor(private readonly staff: AdminStaffService) {}

  @Get('supervisors/:id')
  supervisorDetail(@Param('id', { schema: idSchema }) id: string) {
    return this.staff.supervisorDetail(id);
  }

  @Get('teachers/:id')
  teacherDetail(@Param('id', { schema: idSchema }) id: string) {
    return this.staff.teacherDetail(id);
  }

  @Post('teachers/:id/move')
  @HttpCode(204)
  async moveTeacher(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: moveTeacherSchema }) body: MoveTeacherDto,
  ) {
    await this.staff.moveTeacher(admin, id, body.scopeId);
  }

  @Patch('circles/:id')
  @HttpCode(204)
  async updateCircle(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateCircleSchema }) body: UpdateAdminCircleDto,
  ) {
    await this.staff.updateCircle(admin, id, body);
  }

  @Delete('circles/:id')
  @HttpCode(204)
  async archiveCircle(@CurrentStaff() admin: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.staff.archiveCircle(admin, id);
  }

  @Post('circles/:id/students')
  @HttpCode(204)
  async assignStudent(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: assignStudentSchema }) body: AssignStudentDto,
  ) {
    await this.staff.assignStudent(admin, id, body.studentId);
  }

  @Delete('circles/:id/students/:studentId')
  @HttpCode(204)
  async removeStudent(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Param('studentId', { schema: idSchema }) studentId: string,
  ) {
    await this.staff.removeStudent(admin, id, studentId);
  }

  @Post('transfers')
  requestTransfer(@CurrentStaff() admin: StaffActor, @Body({ schema: requestTransferSchema }) body: RequestTransferDto) {
    return this.staff.requestTransfer(admin, body);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(204)
  async cancelTransfer(@CurrentStaff() admin: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.staff.cancelTransfer(admin, id);
  }
}
