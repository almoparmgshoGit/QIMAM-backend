import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import { PlanService } from './plan.service.js';

export interface AdmissionDecision {
  accepted: boolean;
  score: number | null;
  note: string | null;
}

/** The recitation test before a student starts. A student's plan begins only once accepted. */
@Injectable()
export class AdmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Waiting students first. The phone number is here because whoever runs the test must reach them. */
  async list() {
    const rows = await this.prisma.user.findMany({
      where: { role: 'STUDENT', admissionStatus: { in: ['PENDING', 'REJECTED'] } },
      orderBy: [{ admissionStatus: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      select: {
        id: true,
        fullName: true,
        phone: true,
        country: true,
        ageBand: true,
        section: true,
        createdAt: true,
        admissionStatus: true,
        admissionScore: true,
        admissionNote: true,
        admissionDecidedAt: true,
        trackTemplate: { select: { name: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.fullName,
      phone: row.phone,
      country: row.country,
      ageBand: row.ageBand,
      section: row.section,
      track: row.trackTemplate?.name ?? null,
      createdAt: row.createdAt,
      status: row.admissionStatus,
      score: row.admissionScore === null ? null : Number(row.admissionScore),
      note: row.admissionNote,
      decidedAt: row.admissionDecidedAt,
    }));
  }

  /** A rejected student may be tested again later, so a rejection can still be changed. */
  async decide(staff: StaffActor, studentId: string, { accepted, score, note }: AdmissionDecision): Promise<void> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: studentId, role: 'STUDENT', admissionStatus: { in: ['PENDING', 'REJECTED'] } },
      data: {
        admissionStatus: accepted ? 'ACCEPTED' : 'REJECTED',
        admissionScore: score,
        admissionNote: note,
        admissionDecidedAt: new Date(),
      },
    });
    if (count !== 1) throw new ApiError(404, 'not_found');

    if (accepted) await this.plans.startPlan(studentId);
    await this.notifications.send([studentId], {
      type: 'GENERAL',
      title: accepted ? 'تم قبولك في البرنامج' : 'نتيجة اختبار القبول',
      body: accepted ? 'اجتزتِ اختبار التلاوة، وبدأت خطتك الآن. بارك الله فيك.' : (note ?? 'لم يتم القبول هذه المرة، ويمكنك إعادة الاختبار لاحقًا.'),
    });
    await this.audit.record(staff, accepted ? 'admission.accept' : 'admission.reject', { type: 'student', id: studentId }, { score });
  }
}
