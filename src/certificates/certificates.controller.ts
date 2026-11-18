import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CurrentUserId } from '../auth/current-user.decorator.js';
import {
  CurrentStaff,
  Dashboard,
  Permissions,
  Roles,
  type StaffActor,
} from '../auth/staff.decorators.js';
import { idSchema } from '../common/staff-api.js';
import {
  createAssetSchema,
  type CreateAssetDto,
  createTemplateSchema,
  type CreateTemplateDto,
  honorSchema,
  type HonorDto,
  issueSchema,
  type IssueDto,
  updateTemplateSchema,
  type UpdateTemplateDto,
} from './certificates.schemas.js';
import {
  CertificatesService,
  MAX_ASSET_BYTES,
  MAX_BACKGROUND_BYTES,
} from './certificates.service.js';

// Read in memory and checked before saving. A PDF is turned into an image in the dashboard first.
const backgroundUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_BACKGROUND_BYTES, files: 1 },
});

// A signature or stamp, already cleared of its background in the dashboard, so only a PNG is taken.
const assetUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_ASSET_BYTES, files: 1 },
});

@Dashboard()
@Roles('ADMIN')
@Permissions('certificates.manage')
@Controller('admin/certificates')
export class AdminCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  // The motivation page picks the certificate a circle's honor gives.
  @Get()
  @Permissions('certificates.manage', 'motivation.manage')
  list() {
    return this.certificates.listTemplates();
  }

  // ---------- Attachments: signatures, stamps and headers. Before the :id routes, which would take «assets». ----------

  @Get('assets')
  assets() {
    return this.certificates.listAssets();
  }

  @Post('assets')
  @UseInterceptors(assetUpload)
  createAsset(
    @CurrentStaff() staff: StaffActor,
    @Body({ schema: createAssetSchema }) body: CreateAssetDto,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.certificates.createAsset(staff, body, file);
  }

  @Delete('assets/:id')
  @HttpCode(204)
  async removeAsset(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    await this.certificates.deleteAsset(staff, id);
  }

  @Post()
  create(
    @CurrentStaff() staff: StaffActor,
    @Body({ schema: createTemplateSchema }) body: CreateTemplateDto,
  ) {
    return this.certificates.createTemplate(staff, body);
  }

  @Get('issued/:id')
  renderIssued(@Param('id', { schema: idSchema }) id: string) {
    return this.certificates.render(id);
  }

  @Delete('issued/:id')
  @HttpCode(204)
  async revoke(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    await this.certificates.revoke(staff, id);
  }

  @Get(':id')
  get(@Param('id', { schema: idSchema }) id: string) {
    return this.certificates.getTemplate(id);
  }

  @Patch(':id')
  @HttpCode(204)
  async update(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: updateTemplateSchema }) body: UpdateTemplateDto,
  ) {
    await this.certificates.updateTemplate(staff, id, body);
  }

  @Post(':id/duplicate')
  duplicate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    return this.certificates.duplicateTemplate(staff, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    await this.certificates.deleteTemplate(staff, id);
  }

  @Put(':id/background')
  @HttpCode(204)
  @UseInterceptors(backgroundUpload)
  async setBackground(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    await this.certificates.setBackground(staff, id, file);
  }

  @Delete(':id/background')
  @HttpCode(204)
  async removeBackground(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    await this.certificates.removeBackground(staff, id);
  }

  @Get(':id/issued')
  issued(@Param('id', { schema: idSchema }) id: string) {
    return this.certificates.listIssued(id);
  }

  @Post(':id/issue')
  issue(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: issueSchema }) body: IssueDto,
  ) {
    return this.certificates.issue(staff, id, body);
  }
}

/** Honoring a circle, with the certificates given to its students and its teacher. */
@Dashboard()
@Roles('ADMIN')
@Permissions('motivation.manage')
@Controller('admin/circles')
export class AdminCircleHonorController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get(':id/honor')
  options(@Param('id', { schema: idSchema }) id: string) {
    return this.certificates.honorOptions(id);
  }

  @Post(':id/honor')
  honor(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: honorSchema }) body: HonorDto,
  ) {
    return this.certificates.honorCircle(staff, id, body);
  }
}

/** A teacher's own certificates. Like the student routes, there is no holder id: each reaches only her own. */
@Dashboard()
@Roles('TEACHER', 'SUPERVISOR', 'ADMIN')
@Controller('staff/certificates/mine')
export class StaffCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  list(@CurrentStaff() staff: StaffActor) {
    return this.certificates.staffCertificates(staff.id);
  }

  @Get(':id')
  get(
    @CurrentStaff() staff: StaffActor,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    return this.certificates.render(id, staff.id);
  }
}

// There is no student id in these routes: a student can only ever reach their own certificates.
@Controller('me/certificates')
export class StudentCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  list(@CurrentUserId() studentId: string) {
    return this.certificates.studentCertificates(studentId);
  }

  @Get(':id')
  get(
    @CurrentUserId() studentId: string,
    @Param('id', { schema: idSchema }) id: string,
  ) {
    return this.certificates.render(id, studentId);
  }
}
