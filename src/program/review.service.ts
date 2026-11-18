import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { assertTrackFitsSection, trackFitsSection } from '../common/sections.js';
import { riyadhDate } from '../common/staff-api.js';
import type { ReviewFinalKind } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import { DAY_MS } from './plan-engine.js';
import { PlanService } from './plan.service.js';
import { FINAL_LABELS, reviewFinished } from './review-rules.js';
import { StageExamService } from './stage-exam.service.js';
import { TrackChangeService } from './track-change.service.js';

const OPEN = ['WAITING', 'SCHEDULED', 'IN_PROGRESS'] as const;
const notFound = () => new ApiError(404, 'not_found');

export interface FinalResultInput {
  note: string | null;
  /** With EXAMINER: the main track a student who passed moves to. Null keeps her where she is. */
  moveToTrackId?: string | null;
}

/**
 * Review tracks. Their plan runs as memorization's does. When the review is over, by the track's rule, the student
 * asks for the final recitation or exam, held as a stage exam with stage 0. A pass may move her to a main track,
 * at once or as the examiner chooses. A failure leads to what the track says: a retake, more review, or a new start.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly stageExams: StageExamService,
    private readonly trackChanges: TrackChangeService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The student's review: when it ends, whether she may ask for the final test, and how it went. Null off a review track. */
  async forStudent(studentId: string) {
    const plan = await this.prisma.studentPlan.findUnique({
      where: { studentId },
      select: {
        status: true,
        reviewEndsOn: true,
        template: {
          select: {
            kind: true,
            reviewEndRule: true,
            reviewFinalKinds: true,
            reviewPassScore: true,
            reviewFailAction: true,
            reviewMoveMode: true,
            reviewNextTrack: { select: { name: true } },
          },
        },
      },
    });
    if (!plan || plan.template.kind !== 'REVIEW') return null;
    const { template } = plan;

    const [open, last] = await Promise.all([
      this.prisma.stageExamSession.findFirst({
        where: { studentId, finalKind: { not: null }, status: { in: [...OPEN] } },
        select: { id: true, finalKind: true, status: true, scheduledAt: true },
      }),
      this.prisma.stageExam.findFirst({
        where: { studentId, finalKind: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { finalKind: true, score: true, passed: true, createdAt: true },
      }),
    ]);

    const today = riyadhDate();
    const scopeDone = plan.status === 'COMPLETED';
    // After a failure the track extends, the extended date is what the student waits for, whatever the rule.
    const extended = last && !last.passed && template.reviewFailAction === 'EXTEND' && plan.reviewEndsOn !== null;
    const finished = extended
      ? today >= plan.reviewEndsOn!
      : reviewFinished({ rule: template.reviewEndRule ?? 'EITHER', endsOn: plan.reviewEndsOn, scopeDone }, today);
    const passed = last?.passed ?? false;

    return {
      endRule: template.reviewEndRule ?? 'EITHER',
      endsOn: plan.reviewEndsOn,
      daysLeft: plan.reviewEndsOn ? Math.max(0, Math.round((plan.reviewEndsOn.getTime() - today.getTime()) / DAY_MS)) : null,
      scopeDone,
      finished,
      passed,
      finalKinds: template.reviewFinalKinds.map((kind) => ({ kind, label: FINAL_LABELS[kind] })),
      passScore: template.reviewPassScore === null ? null : Number(template.reviewPassScore),
      failAction: template.reviewFailAction,
      nextTrack: template.reviewMoveMode === 'AUTO' ? (template.reviewNextTrack?.name ?? null) : null,
      canRequest: finished && !passed && !open && template.reviewFinalKinds.length > 0,
      open: open && { id: open.id, kind: open.finalKind!, label: FINAL_LABELS[open.finalKind!], status: open.status, scheduledAt: open.scheduledAt },
      last: last && { kind: last.finalKind!, label: FINAL_LABELS[last.finalKind!], score: Number(last.score), passed: last.passed, at: last.createdAt },
    };
  }

  /** The student asks for the final test. With two offered she names one; with one it is that one. */
  async request(studentId: string, kind: ReviewFinalKind | null): Promise<void> {
    const status = await this.forStudent(studentId);
    if (!status) throw new ApiError(409, 'not_on_review_track');
    if (status.passed) throw new ApiError(409, 'review_passed');
    if (status.open) throw new ApiError(409, 'final_open');
    if (!status.finished) throw new ApiError(409, 'review_not_finished');
    const offered = status.finalKinds.map((item) => item.kind);
    const chosen = kind ?? (offered.length === 1 ? offered[0] : null);
    if (!chosen || !offered.includes(chosen)) throw new ApiError(400, 'final_kind_invalid');
    if (!(await this.stageExams.openFinal(studentId, chosen, status.last !== null))) throw new ApiError(409, 'final_open');
  }

  /** What the examiner may choose when recording a final test that passes: null for any other exam or track. */
  async moveOptions(teacher: StaffActor, sessionId: string) {
    const session = await this.prisma.stageExamSession.findFirst({
      where: { id: sessionId, examinerId: teacher.id, finalKind: { not: null } },
      select: { student: { select: { section: true, plan: { select: { template: { select: { reviewMoveMode: true, reviewNextTrackId: true } } } } } } },
    });
    const template = session?.student.plan?.template;
    if (!session || !template) return null;
    const tracks = await this.prisma.trackTemplate.findMany({
      where: { kind: 'MEMORIZATION', active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, recitationMode: true },
    });
    return {
      mode: template.reviewMoveMode ?? 'EXAMINER',
      suggested: template.reviewNextTrackId,
      tracks: tracks.filter((track) => trackFitsSection(track.recitationMode, session.student.section)).map(({ id, name }) => ({ id, name })),
    };
  }

  /**
   * Records an exam's result. A final test's pass may move the student, and its failure leads to what the track says.
   * The examiner's choice of track is checked before anything is recorded.
   */
  async recordResult(teacher: StaffActor, sessionId: string, { note, moveToTrackId }: FinalResultInput) {
    const session = await this.prisma.stageExamSession.findFirst({
      where: { id: sessionId, examinerId: teacher.id },
      select: {
        finalKind: true,
        student: {
          select: {
            section: true,
            plan: { select: { template: { select: { reviewMoveMode: true, reviewNextTrackId: true, reviewFailAction: true, reviewExtendDays: true } } } },
          },
        },
      },
    });
    if (!session?.finalKind) {
      if (moveToTrackId) throw new ApiError(400, 'move_not_allowed');
      return this.stageExams.recordResult(teacher, sessionId, note);
    }
    const template = session.student.plan?.template;
    if (!template) throw notFound();
    const mode = template.reviewMoveMode ?? 'EXAMINER';
    if (moveToTrackId && mode !== 'EXAMINER') throw new ApiError(400, 'move_not_allowed');
    const target = mode === 'AUTO' ? template.reviewNextTrackId : (moveToTrackId ?? null);
    if (target && mode === 'EXAMINER') await this.assertMainTrack(target, session.student.section);

    const result = await this.stageExams.recordResult(teacher, sessionId, note);
    if (result.passed) {
      if (target) await this.moveSafely(teacher, result.studentId, target, session.student.section);
    } else {
      await this.afterFailure(result.studentId, template.reviewFailAction ?? 'RETAKE', template.reviewExtendDays ?? 0);
    }
    return { ...result, movedTo: result.passed ? target : null };
  }

  private async assertMainTrack(trackId: string, section: 'MEN' | 'WOMEN') {
    const track = await this.prisma.trackTemplate.findFirst({ where: { id: trackId, kind: 'MEMORIZATION', active: true }, select: { recitationMode: true } });
    if (!track) throw new ApiError(409, 'track_closed');
    assertTrackFitsSection(track.recitationMode, section);
  }

  /** The automatic move skips a track closed since the review track was set up: the pass still stands. */
  private async moveSafely(actor: StaffActor, studentId: string, trackId: string, section: 'MEN' | 'WOMEN') {
    try {
      await this.assertMainTrack(trackId, section);
    } catch {
      return;
    }
    await this.trackChanges.moveAfterReview(actor, studentId, trackId);
  }

  private async afterFailure(studentId: string, action: 'RETAKE' | 'EXTEND' | 'RESTART', extendDays: number) {
    if (action === 'EXTEND') {
      const until = new Date(riyadhDate().getTime() + Math.max(1, extendDays) * DAY_MS);
      await this.prisma.studentPlan.updateMany({ where: { studentId }, data: { reviewEndsOn: until } });
      await this.notify(studentId, `تمدّدت مراجعتك ${Math.max(1, extendDays)} يومًا، ثم {{يمكنك|يمكنكِ}} طلب الاختبار من جديد.`);
    } else if (action === 'RESTART') {
      await this.plans.restartPlan(studentId, true);
      await this.notify(studentId, 'تبدأ مراجعتك من أولها من جديد، وفقك الله.');
    } else {
      await this.notify(studentId, '{{يمكنك|يمكنكِ}} طلب الاختبار مرة أخرى من التطبيق متى {{كنت|كنتِ}} {{مستعدًا|مستعدة}}.');
    }
  }

  private notify(studentId: string, body: string) {
    return this.notifications.send([studentId], { type: 'EVALUATION', title: 'خطة المراجعة', body });
  }
}
