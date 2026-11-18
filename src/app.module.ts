import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module.js';
import { AppController } from './app.controller.js';
import { AccessTokenGuard } from './auth/access-token.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { BadgesModule } from './badges/badges.module.js';
import { CertificatesModule } from './certificates/certificates.module.js';
import { OriginGuard } from './auth/origin.guard.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProgramModule } from './program/program.module.js';
import { RecordingsModule } from './recordings/recordings.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SupervisorModule } from './supervisor/supervisor.module.js';
import { SupportModule } from './support/support.module.js';
import { TeacherModule } from './teacher/teacher.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    // Counts live in this process's memory, which fits one server. More than one needs shared storage.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }] }),
    PrismaModule,
    StorageModule,
    ProgramModule,
    AuthModule,
    UsersModule,
    TeacherModule,
    SupervisorModule,
    RecordingsModule,
    AdminModule,
    BadgesModule,
    CertificatesModule,
    SupportModule,
  ],
  controllers: [AppController],
  providers: [
    ThrottlerGuard,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // In this order: rate limiting covers everything, and a forged origin never reaches the session check.
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: OriginGuard },
    { provide: APP_GUARD, useExisting: AccessTokenGuard },
  ],
})
export class AppModule {}
