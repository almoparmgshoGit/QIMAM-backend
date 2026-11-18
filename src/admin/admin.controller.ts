import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ANY_EMPLOYEE } from '../auth/permissions.js';
import { CurrentStaff, Dashboard, Permissions, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import {
  type CreateAdminCircleDto,
  createCircleSchema,
  type CreateStudentDto,
  createStudentSchema,
  type CreateStaffDto,
  createStaffSchema,
  type ListAuditDto,
  listAuditSchema,
  type ListStaffDto,
  listStaffSchema,
  type ListStudentsDto,
  listStudentsSchema,
  type ListTransfersDto,
  listTransfersSchema,
  type ScopeDto,
  scopeSchema,
  type UpdateStaffDto,
  updateStaffSchema,
} from './admin.schemas.js';
import { AdminService } from './admin.service.js';

@Dashboard()
@Roles('ADMIN')
@Permissions('accounts.manage')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // Other pages pick a teacher or name an actor from this list.
  @Get('staff')
  @Permissions('accounts.manage', 'audit.view', 'motivation.manage')
  listStaff(@Query({ schema: listStaffSchema }) query: ListStaffDto) {
    return this.admin.listStaff(query);
  }

  @Post('staff')
  createStaff(@CurrentStaff() staff: StaffActor, @Body({ schema: createStaffSchema }) body: CreateStaffDto) {
    return this.admin.createStaff(staff, body);
  }

  @Patch('staff/:id')
  updateStaff(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateStaffSchema }) body: UpdateStaffDto,
  ) {
    return this.admin.updateStaff(staff, id, body);
  }

  @Delete('staff/:id')
  @HttpCode(204)
  async deleteStaff(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.deleteStaff(staff, id);
  }

  @Post('staff/:id/reset-credentials')
  @HttpCode(200)
  resetStaffCredentials(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    return this.admin.resetStaffCredentials(staff, id);
  }

  @Get('scopes')
  @Permissions(ANY_EMPLOYEE)
  listScopes() {
    return this.admin.listScopes();
  }

  @Post('scopes')
  createScope(@CurrentStaff() staff: StaffActor, @Body({ schema: scopeSchema }) body: ScopeDto) {
    return this.admin.createScope(staff, body.name);
  }

  @Patch('scopes/:id')
  renameScope(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: scopeSchema }) body: ScopeDto,
  ) {
    return this.admin.renameScope(staff, id, body.name);
  }

  // Other pages pick students from this list.
  @Get('students')
  @Permissions('students.manage', 'accounts.manage', 'certificates.manage', 'gates.manage')
  listStudents(@Query({ schema: listStudentsSchema }) query: ListStudentsDto) {
    return this.admin.listStudents(query);
  }

  @Post('students')
  @Permissions('students.manage')
  createStudent(@CurrentStaff() staff: StaffActor, @Body({ schema: createStudentSchema }) body: CreateStudentDto) {
    return this.admin.createStudent(staff, body);
  }

  @Get('transfers')
  listTransfers(@Query({ schema: listTransfersSchema }) query: ListTransfersDto) {
    return this.admin.listTransfers(query);
  }

  @Post('transfers/:id/approve')
  @HttpCode(204)
  async approveTransfer(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.approveTransfer(staff, id);
  }

  @Post('transfers/:id/reject')
  @HttpCode(204)
  async rejectTransfer(@CurrentStaff() staff: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.admin.rejectTransfer(staff, id);
  }

  @Get('circles')
  @Permissions(ANY_EMPLOYEE)
  listCircles() {
    return this.admin.listCircles();
  }

  @Post('circles')
  createCircle(@CurrentStaff() staff: StaffActor, @Body({ schema: createCircleSchema }) body: CreateAdminCircleDto) {
    return this.admin.createCircle(staff, body);
  }

  @Get('audit')
  @Permissions('audit.view')
  listAudit(@Query({ schema: listAuditSchema }) query: ListAuditDto) {
    return this.admin.listAudit(query);
  }
}
