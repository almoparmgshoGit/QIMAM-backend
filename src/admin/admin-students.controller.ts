import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { AdminStudentsService } from './admin-students.service.js';
import { type MoveStudentDto, moveStudentSchema, type UpdateStudentDto, updateStudentSchema } from './admin.schemas.js';

@Dashboard()
@Roles('ADMIN')
@Permissions('students.manage')
@Controller('admin/students')
export class AdminStudentsController {
  constructor(private readonly students: AdminStudentsService) {}

  @Get(':id')
  detail(@Param('id', { schema: idSchema }) id: string) {
    return this.students.detail(id);
  }

  @Get(':id/record')
  record(@Param('id', { schema: idSchema }) id: string) {
    return this.students.record(id);
  }

  @Patch(':id')
  @HttpCode(204)
  async update(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateStudentSchema }) body: UpdateStudentDto,
  ) {
    await this.students.update(admin, id, body);
  }

  @Post(':id/move')
  @HttpCode(204)
  async move(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: moveStudentSchema }) body: MoveStudentDto,
  ) {
    await this.students.move(admin, id, body.circleId);
  }

  @Post(':id/reset-plan')
  @HttpCode(204)
  async resetPlan(@CurrentStaff() admin: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.students.resetPlan(admin, id);
  }

  @Post(':id/sign-out')
  @HttpCode(204)
  async signOut(@CurrentStaff() admin: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.students.signOut(admin, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentStaff() admin: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.students.remove(admin, id);
  }
}
