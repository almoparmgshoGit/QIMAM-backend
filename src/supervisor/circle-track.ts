import { ApiError } from '../common/api-error.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const OPEN_TRANSFER = ['PENDING_ADMIN', 'PENDING_TEACHER'] as const;

/** Each circle belongs to one track, and a track has as many circles as its students need. Age plays no part. */
export async function assertStudentFitsCircle(prisma: PrismaService, circleId: string, studentId: string): Promise<void> {
  const [circle, student] = await Promise.all([
    prisma.circle.findUnique({ where: { id: circleId }, select: { trackTemplateId: true } }),
    prisma.user.findUnique({ where: { id: studentId }, select: { trackTemplateId: true } }),
  ]);
  if (!circle?.trackTemplateId) throw new ApiError(409, 'circle_has_no_track');
  if (student?.trackTemplateId !== circle.trackTemplateId) throw new ApiError(409, 'track_mismatch');
}

/** A circle can't move to a track while a student in it, or on her way to it, is on another. */
export async function assertTrackFitsCircle(prisma: PrismaService, circleId: string, trackId: string): Promise<void> {
  const onAnotherTrack = { OR: [{ trackTemplateId: null }, { trackTemplateId: { not: trackId } }] };
  const [members, incoming] = await Promise.all([
    prisma.circleMembership.count({ where: { circleId, leftAt: null, student: onAnotherTrack } }),
    prisma.transferRequest.count({ where: { toCircleId: circleId, status: { in: [...OPEN_TRANSFER] }, student: onAnotherTrack } }),
  ]);
  if (members + incoming > 0) throw new ApiError(409, 'circle_has_other_track');
}

/** A new circle takes an open track. A closed one stays on circles that already have it. */
export async function assertOpenTrack(prisma: PrismaService, trackId: string): Promise<void> {
  const track = await prisma.trackTemplate.findFirst({ where: { id: trackId, active: true }, select: { id: true } });
  if (!track) throw new ApiError(400, 'unknown_track');
}
