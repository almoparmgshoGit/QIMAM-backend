import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import {
  AdminCertificatesController,
  AdminCircleHonorController,
  StaffCertificatesController,
  StudentCertificatesController,
} from './certificates.controller.js';
import { CertificatesService } from './certificates.service.js';

@Module({
  imports: [AuthModule],
  controllers: [
    AdminCertificatesController,
    AdminCircleHonorController,
    StaffCertificatesController,
    StudentCertificatesController,
  ],
  providers: [CertificatesService],
})
export class CertificatesModule {}
