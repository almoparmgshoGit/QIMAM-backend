import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentStaff, Dashboard, Roles, type StaffActor } from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import { AdminRanksService } from './admin-ranks.service.js';
import { type RankDto, rankSchema, type UpdateRankDto, updateRankSchema } from './admin.schemas.js';

/**
 * Employee ranks and what each may do. For administrators only, with no permission that opens it to an employee:
 * an employee who could edit ranks could grant themselves anything.
 */
@Dashboard()
@Roles('ADMIN')
@Controller('admin')
export class AdminRanksController {
  constructor(private readonly ranks: AdminRanksService) {}

  @Get('permissions')
  permissions() {
    return this.ranks.permissions();
  }

  @Get('ranks')
  list() {
    return this.ranks.list();
  }

  @Post('ranks')
  create(@CurrentStaff() admin: StaffActor, @Body({ schema: rankSchema }) body: RankDto) {
    return this.ranks.create(admin, body);
  }

  @Patch('ranks/:id')
  update(
    @CurrentStaff() admin: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateRankSchema }) body: UpdateRankDto,
  ) {
    return this.ranks.update(admin, id, body);
  }

  @Delete('ranks/:id')
  @HttpCode(204)
  async remove(@CurrentStaff() admin: StaffActor, @Param('id', { schema: idSchema }) id: string) {
    await this.ranks.remove(admin, id);
  }
}
