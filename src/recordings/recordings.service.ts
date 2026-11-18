import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { pageArgs } from '../common/staff-api.js';
import { findSurah } from '../common/surahs.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { filePaths, StorageService } from '../storage/storage.service.js';
import { TeacherService } from '../teacher/teacher.service.js';
import {
  type EvaluateRecordingDto,
  type ListRecordingsDto,
  MAX_PENDING_RECORDINGS,
  type UploadRecordingDto,
} from './recordings.schemas.js';

const notFound = () => new ApiError(404, 'not_found');

/** What the staff may reach: the students of a teacher's circles, or of a supervisor's scope, as they are now. */
type Reach = Prisma.CircleWhereInput;

const RECORDING_SELECT = {
  id: true,
  title: true,
  surah: true,
  fromAyah: true,
  toAyah: true,
  durationMs: true,
  createdAt: true,
  reviewedAt: true,
  student: { select: { id: true, fullName: true } },
  evaluation: {
    select: { id: true, score: true, maxScore: true, comment: true, segmentStatus: true, teacher: { select: { fullName: true } } },
  },
} satisfies Prisma.RecitationRecordingSelect;

type RecordingRow = Prisma.RecitationRecordingGetPayload<{ select: typeof RECORDING_SELECT }>;

/**
 * The file's own first bytes decide what it is, whatever the upload claims. The app records AAC in an MP4
 * container; WebM is what a browser records.
 */
function audioType(data: Buffer): string | null {
  if (data.length > 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (data.length > 4 && data.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  return null;
}

function toRecording(row: RecordingRow) {
  const evaluation = row.evaluation;
  return {
    id: row.id,
    student: { id: row.student.id, name: row.student.fullName },
    title: row.title,
    surah: row.surah,
    fromAyah: row.fromAyah,
    toAyah: row.toAyah,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    status: row.reviewedAt ? ('reviewed' as const) : ('pending' as const),
    evaluation: evaluation && {
      id: evaluation.id,
      score: evaluation.score === null ? null : Number(evaluation.score),
      maxScore: Number(evaluation.maxScore),
      note: evaluation.comment,
      segmentStatus: evaluation.segmentStatus,
      by: evaluation.teacher?.fullName ?? null,
    },
  };
}

@Injectable()
export class RecordingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly teachers: TeacherService,
    private readonly storage: StorageService,
  ) {}

  // ---------- The student ----------

  /** A recording goes to the teacher of the student's current circle, so a student with no circle can't send one. */
  async upload(studentId: string, dto: UploadRecordingDto, file: { buffer: Buffer } | undefined) {
    if (!file || file.buffer.length === 0) throw new ApiError(400, 'file_required');
    const mimeType = audioType(file.buffer);
    if (!mimeType) throw new ApiError(415, 'unsupported_audio');
    const surah = findSurah(dto.surah);
    if (!surah || dto.toAyah > surah.ayahCount) throw new ApiError(400, 'ayah_out_of_range');

    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null, circle: { archivedAt: null } },
      select: { circleId: true },
    });
    if (!membership) throw new ApiError(409, 'no_circle');
    // Only a track that recites by recording takes them. Students with no track yet keep the default, online.
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { trackTemplate: { select: { recitationMode: true } } },
    });
    if (student?.trackTemplate?.recitationMode !== 'RECORDING') throw new ApiError(409, 'track_has_no_recordings');
    const pending = await this.prisma.recitationRecording.count({ where: { studentId, reviewedAt: null } });
    if (pending >= MAX_PENDING_RECORDINGS) throw new ApiError(409, 'too_many_pending_recordings');

    const title = `${surah.name} · ${dto.fromAyah}-${dto.toAyah}`;
    const row = await this.prisma.recitationRecording.create({
      data: {
        studentId,
        circleId: membership.circleId,
        title,
        surah: dto.surah,
        fromAyah: dto.fromAyah,
        toAyah: dto.toAyah,
        durationMs: dto.durationMs,
        mimeType,
        sizeBytes: file.buffer.length,
      },
      select: RECORDING_SELECT,
    });
    // The sound goes to the student's own folder. A recording whose file couldn't be written is not kept.
    try {
      await this.storage.write(filePaths.recording(studentId, row.id, mimeType), file.buffer);
    } catch (error) {
      await this.prisma.recitationRecording.delete({ where: { id: row.id } });
      throw error;
    }
    await this.notifications.notifyTeacherOf(studentId, {
      type: 'GENERAL',
      title: 'تسميع مسجّل جديد',
      body: `${row.student.fullName}: ${title}`,
      dedupeKey: `recording:${row.id}`,
    });
    return toRecording(row);
  }

  async listMine(studentId: string) {
    const rows = await this.prisma.recitationRecording.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: RECORDING_SELECT,
    });
    return rows.map(toRecording);
  }

  myAudio(studentId: string, id: string) {
    return this.audio({ id, studentId });
  }

  /** A recording no one has evaluated yet can be withdrawn, such as one sent by mistake. */
  async withdraw(studentId: string, id: string): Promise<void> {
    const row = await this.prisma.recitationRecording.findFirst({ where: { id, studentId }, select: { mimeType: true } });
    if (!row) throw notFound();
    const { count } = await this.prisma.recitationRecording.deleteMany({ where: { id, studentId, reviewedAt: null } });
    if (count === 0) throw new ApiError(409, 'recording_already_reviewed');
    await this.storage.remove(filePaths.recording(studentId, id, row.mimeType));
  }

  // ---------- The staff ----------

  async list(reach: Reach, query: ListRecordingsDto) {
    const where: Prisma.RecitationRecordingWhereInput = {
      student: { memberships: { some: { leftAt: null, circle: reach } } },
      ...(query.studentId ? { studentId: query.studentId } : {}),
    };
    const status =
      query.status === 'pending' ? { reviewedAt: null } : query.status === 'reviewed' ? { reviewedAt: { not: null } } : {};
    const [rows, total, pending] = await Promise.all([
      this.prisma.recitationRecording.findMany({
        where: { ...where, ...status },
        // The oldest waiting first, so nothing is left behind. Reviewed ones, newest first.
        orderBy: query.status === 'pending' ? { createdAt: 'asc' } : { createdAt: 'desc' },
        select: RECORDING_SELECT,
        ...pageArgs(query),
      }),
      this.prisma.recitationRecording.count({ where: { ...where, ...status } }),
      this.prisma.recitationRecording.count({ where: { ...where, reviewedAt: null } }),
    ]);
    return { total, pending, items: rows.map(toRecording) };
  }

  staffAudio(reach: Reach, id: string) {
    return this.audio({ id, student: { memberships: { some: { leftAt: null, circle: reach } } } });
  }

  /**
   * Evaluates a recording once. The recording is claimed first, so two evaluations sent at the same moment
   * can't both go through. The evaluation then joins the student's segments, as a live one does.
   */
  async evaluate(staff: StaffActor, reach: Reach, id: string, dto: EvaluateRecordingDto) {
    const recording = await this.prisma.recitationRecording.findFirst({
      where: { id, student: { memberships: { some: { leftAt: null, circle: reach } } } },
      select: {
        studentId: true,
        surah: true,
        fromAyah: true,
        toAyah: true,
        student: { select: { memberships: { where: { leftAt: null }, select: { circleId: true }, take: 1 } } },
      },
    });
    const circleId = recording?.student.memberships[0]?.circleId;
    if (!recording || !circleId) throw notFound();

    const { count } = await this.prisma.recitationRecording.updateMany({ where: { id, reviewedAt: null }, data: { reviewedAt: new Date() } });
    if (count === 0) throw new ApiError(409, 'recording_already_reviewed');

    try {
      const evaluation = await this.teachers.saveEvaluation(staff, recording.studentId, circleId, {
        surah: recording.surah,
        fromAyah: recording.fromAyah,
        toAyah: recording.toAyah,
        score: dto.score,
        note: dto.note,
        segmentStatus: dto.segmentStatus,
        attendance: null,
      }, { fromRecording: true });
      const row = await this.prisma.recitationRecording.update({
        where: { id },
        data: { evaluationId: evaluation.id },
        select: RECORDING_SELECT,
      });
      await this.audit.record(staff, 'recording.evaluate', { type: 'student', id: recording.studentId }, { recordingId: id, evaluationId: evaluation.id });
      return toRecording(row);
    } catch (error) {
      // Nothing was saved, so it waits again.
      await this.prisma.recitationRecording.updateMany({ where: { id, evaluationId: null }, data: { reviewedAt: null } });
      throw error;
    }
  }

  /** From the student's folder, or, for a recording sent before files moved there, from the database. */
  private async audio(where: Prisma.RecitationRecordingWhereInput) {
    const row = await this.prisma.recitationRecording.findFirst({ where, select: { id: true, studentId: true, mimeType: true } });
    if (!row) throw notFound();
    const onDisk = await this.storage.read(filePaths.recording(row.studentId, row.id, row.mimeType));
    if (onDisk) return { mimeType: row.mimeType, data: onDisk };
    const legacy = await this.prisma.recitationAudio.findUnique({ where: { recordingId: row.id }, select: { data: true } });
    if (!legacy?.data) throw notFound();
    return { mimeType: row.mimeType, data: Buffer.from(legacy.data) };
  }
}
