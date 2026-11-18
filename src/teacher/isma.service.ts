import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { forSection } from '../common/sections.js';
import type { AttendanceStatus, IsmaEntryMode, IsmaMarkKind, IsmaTurnStatus } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { type IsmaState, VoiceService } from '../voice/voice.service.js';
import type { IsmaNotifyDto } from './teacher.schemas.js';

type QueueTurn = { studentId: string; position: number; status: IsmaTurnStatus };
type Notice = { title: string; body: string };

const notFound = () => new ApiError(404, 'not_found');

/**
 * Where one student stands: her number in the whole queue, and how many are still before her. The student
 * reciting now counts as before everyone who waits.
 */
export function ismaStateOf(turns: QueueTurn[], studentId: string, entryMode: IsmaEntryMode): IsmaState | null {
  const ordered = [...turns].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((turn) => turn.studentId === studentId);
  if (index < 0) return null;
  const own = ordered[index];
  const reciting = ordered.some(({ status }) => status === 'ACTIVE') ? 1 : 0;
  const waitingBefore = ordered.slice(0, index).filter(({ status }) => status === 'WAITING').length;
  return {
    position: index + 1,
    ahead: own.status === 'WAITING' ? waitingBefore + reciting : 0,
    next: own.status === 'WAITING' && waitingBefore === 0,
    status: own.status,
    entryMode,
  };
}

const turnReminder = (state: IsmaState) =>
  state.status === 'ACTIVE'
    ? { title: 'حان دورك الآن في حلقة الإسماع', body: '{{ادخل|ادخلي}} الجلسة {{وابدأ|وابدئي}} التسميع.' }
    : state.next
      ? { title: 'دورك التالي في حلقة الإسماع', body: `دورك رقم ${state.position}، {{وأنت التالي|وأنتِ التالية}}. {{استعد|استعدي}}.` }
      : {
          title: 'تذكير بدورك في حلقة الإسماع',
          body: `دورك رقم ${state.position}، وبقي قبلك ${state.ahead === 1 ? 'واحد' : `${state.ahead}`} من الحلقة.`,
        };

/**
 * حلقة الإسماع: the circle's students recite one after another in a single voice room, in an order the teacher
 * sets and changes as she goes. Everything she records here, the marks, attendance and evaluations, is saved
 * as it happens, so nothing waits for the session to end.
 */
@Injectable()
export class IsmaService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly voice: VoiceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.voice.onStudentJoined((roomId, studentId) => {
      void this.studentJoined(roomId, studentId).catch(() => undefined);
    });
  }

  /** The queue is the circle as it is when the session starts, in the order of its attendance sheet. */
  async openQueue(sessionId: string, circleId: string, title: string): Promise<void> {
    const members = await this.prisma.circleMembership.findMany({
      where: { circleId, leftAt: null, student: { status: 'ACTIVE' } },
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { joinedAt: 'asc' }],
      select: { studentId: true },
    });
    await this.prisma.ismaTurn.createMany({
      data: members.map(({ studentId }, index) => ({ sessionId, studentId, position: index + 1 })),
      skipDuplicates: true,
    });
    const session = await this.queue(sessionId);
    for (const { studentId } of session.turns) {
      const state = ismaStateOf(session.turns, studentId, session.entryMode);
      if (!state) continue;
      await this.notifications.send([studentId], {
        type: 'GENERAL',
        title: 'بدأت حلقة الإسماع',
        body: `${title}. دورك رقم ${state.position}${
          session.entryMode === 'TURN' ? '، {{وتدخل|وتدخلين}} الجلسة عندما يحين دورك.' : '، {{وتستطيع|وتستطيعين}} الدخول الآن.'
        }`,
        dedupeKey: `isma-start:${sessionId}`,
      });
    }
  }

  /** The teacher's whole view of the room: the queue, who is in it now, and what she recorded for each. */
  async room(teacher: StaffActor, sessionId: string) {
    const session = await this.ownSession(teacher, sessionId);
    const [turns, evaluations] = await Promise.all([
      this.prisma.ismaTurn.findMany({
        where: { sessionId },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          status: true,
          attendance: true,
          joinedAt: true,
          startedAt: true,
          endedAt: true,
          student: { select: { id: true, fullName: true } },
          marks: { orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, note: true, createdAt: true } },
        },
      }),
      this.prisma.evaluation.findMany({
        where: { liveSessionId: sessionId },
        select: { id: true, studentId: true, title: true, score: true, maxScore: true, segmentStatus: true },
      }),
    ]);
    const present = this.voice.present(sessionId);
    const evaluationOf = new Map(evaluations.map((row) => [row.studentId, row]));
    const queue = turns.map(({ student, status, position }) => ({ studentId: student.id, status, position }));

    return {
      entryMode: session.entryMode ?? 'OPEN',
      turns: turns.map((turn) => {
        const evaluation = evaluationOf.get(turn.student.id);
        return {
          id: turn.id,
          position: turn.position,
          status: turn.status,
          attendance: turn.attendance,
          joinedAt: turn.joinedAt,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          online: present.has(turn.student.id),
          ahead: ismaStateOf(queue, turn.student.id, session.entryMode ?? 'OPEN')?.ahead ?? 0,
          student: { id: turn.student.id, name: turn.student.fullName },
          marks: turn.marks,
          evaluation: evaluation && {
            id: evaluation.id,
            title: evaluation.title,
            score: evaluation.score === null ? null : Number(evaluation.score),
            maxScore: Number(evaluation.maxScore),
            segmentStatus: evaluation.segmentStatus,
          },
        };
      }),
    };
  }

  /**
   * A new order for the whole queue. Every student still waiting whose place changed hears her new one, on her
   * phone and in the room.
   */
  async reorder(teacher: StaffActor, sessionId: string, turnIds: string[]): Promise<void> {
    const session = await this.liveSession(teacher, sessionId);
    const turns = await this.prisma.ismaTurn.findMany({ where: { sessionId }, select: { id: true, studentId: true, position: true, status: true } });
    if (turnIds.length !== turns.length || new Set(turnIds).size !== turns.length || turnIds.some((id) => !turns.some((turn) => turn.id === id))) {
      throw new ApiError(400, 'invalid_order');
    }
    const before = new Map(turns.map((turn) => [turn.studentId, ismaStateOf(turns, turn.studentId, session.entryMode)]));
    const next = turns.map((turn) => ({ ...turn, position: turnIds.indexOf(turn.id) + 1 }));

    await this.prisma.$transaction(next.map(({ id, position }) => this.prisma.ismaTurn.update({ where: { id }, data: { position } })));
    await this.audit.record(teacher, 'isma.reorder', { type: 'session', id: sessionId });

    for (const turn of next) {
      const state = ismaStateOf(next, turn.studentId, session.entryMode);
      const old = before.get(turn.studentId);
      if (!state || state.status !== 'WAITING' || (old && old.position === state.position && old.ahead === state.ahead)) continue;
      await this.tell(sessionId, turn.studentId, {
        title: 'تغيّر ترتيب دورك في حلقة الإسماع',
        body: `أصبح دورك رقم ${state.position}${state.ahead > 0 ? `، وقبلك ${state.ahead}` : '، {{وأنت التالي|وأنتِ التالية}}'}.`,
      });
    }
    this.broadcast(sessionId, next, session.entryMode);
  }

  /**
   * Gives the turn to this student. Whoever was reciting is done. She hears that her turn has come, and the one
   * after her that she is next.
   */
  async activate(teacher: StaffActor, sessionId: string, turnId: string): Promise<void> {
    const session = await this.liveSession(teacher, sessionId);
    const turn = await this.ownTurn(sessionId, turnId);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.ismaTurn.updateMany({ where: { sessionId, status: 'ACTIVE' }, data: { status: 'DONE', endedAt: now } }),
      this.prisma.ismaTurn.update({ where: { id: turn.id }, data: { status: 'ACTIVE', startedAt: now, endedAt: null } }),
    ]);
    await this.audit.record(teacher, 'isma.turn', { type: 'session', id: sessionId }, { studentId: turn.studentId });

    const turns = await this.queueTurns(sessionId);
    await this.tell(sessionId, turn.studentId, turnReminder(ismaStateOf(turns, turn.studentId, session.entryMode)!));
    const following = turns.filter(({ status }) => status === 'WAITING').sort((a, b) => a.position - b.position)[0];
    if (following) await this.tell(sessionId, following.studentId, turnReminder(ismaStateOf(turns, following.studentId, session.entryMode)!));
    this.broadcast(sessionId, turns, session.entryMode);
  }

  /** The student reciting now has finished, and nobody holds the turn until the teacher gives it. */
  async finishTurn(teacher: StaffActor, sessionId: string, turnId: string): Promise<void> {
    const session = await this.liveSession(teacher, sessionId);
    const { count } = await this.prisma.ismaTurn.updateMany({
      where: { id: turnId, sessionId, status: 'ACTIVE' },
      data: { status: 'DONE', endedAt: new Date() },
    });
    if (count !== 1) throw new ApiError(409, 'invalid_turn_state');
    this.broadcast(sessionId, await this.queueTurns(sessionId), session.entryMode);
  }

  async addMark(teacher: StaffActor, sessionId: string, turnId: string, kind: IsmaMarkKind) {
    await this.liveSession(teacher, sessionId);
    const turn = await this.ownTurn(sessionId, turnId);
    return this.prisma.ismaMark.create({
      data: { turnId: turn.id, kind },
      select: { id: true, kind: true, note: true, createdAt: true },
    });
  }

  async noteMark(teacher: StaffActor, sessionId: string, markId: string, note: string) {
    await this.ownSession(teacher, sessionId);
    const { count } = await this.prisma.ismaMark.updateMany({
      where: { id: markId, turn: { sessionId } },
      data: { note: note || null },
    });
    if (count !== 1) throw notFound();
  }

  async deleteMark(teacher: StaffActor, sessionId: string, markId: string): Promise<void> {
    await this.ownSession(teacher, sessionId);
    const { count } = await this.prisma.ismaMark.deleteMany({ where: { id: markId, turn: { sessionId } } });
    if (count !== 1) throw notFound();
  }

  /** The turn's own record. The caller writes the day's attendance, so the sheet shows it at once. */
  async setAttendance(teacher: StaffActor, sessionId: string, turnId: string, attendance: AttendanceStatus) {
    const session = await this.ownSession(teacher, sessionId);
    const turn = await this.ownTurn(sessionId, turnId);
    await this.prisma.ismaTurn.update({ where: { id: turn.id }, data: { attendance } });
    return { studentId: turn.studentId, circleId: session.circleId, day: session.startedAt ?? session.scheduledAt };
  }

  /** For the evaluation the caller saves: whose turn it is, in which circle, and on which day. */
  async turnForEvaluation(teacher: StaffActor, sessionId: string, turnId: string) {
    const session = await this.ownSession(teacher, sessionId);
    if (session.status !== 'IN_PROGRESS' && session.status !== 'COMPLETED') throw new ApiError(409, 'invalid_session_state');
    const turn = await this.ownTurn(sessionId, turnId);
    return { studentId: turn.studentId, circleId: session.circleId, day: session.startedAt ?? session.scheduledAt };
  }

  async recordEvaluatedAttendance(turnId: string, attendance: AttendanceStatus): Promise<void> {
    await this.prisma.ismaTurn.update({ where: { id: turnId }, data: { attendance } });
  }

  /** Sends to one student, or to everyone: a reminder to those still waiting, or the teacher's words to the whole queue. */
  async notify(teacher: StaffActor, sessionId: string, dto: IsmaNotifyDto): Promise<{ sent: number }> {
    const session = await this.liveSession(teacher, sessionId);
    const turns = await this.queueTurns(sessionId);
    if (dto.studentId && !turns.some(({ studentId }) => studentId === dto.studentId)) throw notFound();
    const targets = turns.filter(({ studentId, status }) =>
      dto.studentId ? studentId === dto.studentId : dto.kind === 'CUSTOM' || status === 'WAITING',
    );

    let sent = 0;
    for (const { studentId } of targets) {
      let message: Notice;
      if (dto.kind === 'TURN_REMINDER') {
        const state = ismaStateOf(turns, studentId, session.entryMode)!;
        if (state.status === 'DONE') continue;
        message = turnReminder(state);
      } else {
        message = { title: dto.title || 'رسالة من {{معلمك|معلمتك}} في حلقة الإسماع', body: dto.body! };
      }
      sent += await this.tell(sessionId, studentId, message);
    }
    await this.audit.record(teacher, 'isma.notify', { type: 'session', id: sessionId }, { kind: dto.kind, toOne: Boolean(dto.studentId) });
    return { sent };
  }

  /**
   * The session ended. Whoever was reciting is done. Returns the students who entered the room but whose
   * attendance the teacher never marked, so the caller records them present, and those who recited.
   */
  async close(sessionId: string) {
    await this.prisma.ismaTurn.updateMany({ where: { sessionId, status: 'ACTIVE' }, data: { status: 'DONE', endedAt: new Date() } });
    const turns = await this.prisma.ismaTurn.findMany({
      where: { sessionId },
      select: { studentId: true, status: true, attendance: true, joinedAt: true },
    });
    return {
      unmarkedPresent: turns.filter(({ joinedAt, attendance }) => joinedAt && !attendance).map(({ studentId }) => studentId),
      recited: turns.filter(({ status }) => status === 'DONE').map(({ studentId }) => studentId),
    };
  }

  /** On her phone, and in the room as well when she is in it, in the wording of her own section. */
  private async tell(sessionId: string, studentId: string, message: Notice): Promise<number> {
    const sent = await this.notifications.send([studentId], { type: 'GENERAL', ...message });
    if (this.voice.present(sessionId).has(studentId)) {
      const { section } = await this.prisma.user.findUniqueOrThrow({ where: { id: studentId }, select: { section: true } });
      this.voice.sendToStudent(sessionId, studentId, {
        type: 'isma-notice',
        title: forSection(message.title, section),
        body: forSection(message.body, section),
      });
    }
    return sent;
  }

  private async studentJoined(sessionId: string, studentId: string): Promise<void> {
    const turn = await this.prisma.ismaTurn.findUnique({
      where: { sessionId_studentId: { sessionId, studentId } },
      select: { id: true, joinedAt: true, session: { select: { entryMode: true } } },
    });
    if (!turn) return;
    if (!turn.joinedAt) await this.prisma.ismaTurn.update({ where: { id: turn.id }, data: { joinedAt: new Date() } });
    const state = ismaStateOf(await this.queueTurns(sessionId), studentId, turn.session.entryMode ?? 'OPEN');
    if (state) this.voice.sendToStudent(sessionId, studentId, { type: 'isma-state', state });
  }

  /** Each student in the room learns where she now stands, and whether her microphone is open. */
  private broadcast(sessionId: string, turns: QueueTurn[], entryMode: IsmaEntryMode): void {
    for (const studentId of this.voice.present(sessionId)) {
      const state = ismaStateOf(turns, studentId, entryMode);
      if (state) this.voice.sendToStudent(sessionId, studentId, { type: 'isma-state', state });
    }
  }

  private queueTurns(sessionId: string): Promise<QueueTurn[]> {
    return this.prisma.ismaTurn.findMany({ where: { sessionId }, select: { studentId: true, position: true, status: true } });
  }

  private async queue(sessionId: string) {
    const session = await this.prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId }, select: { entryMode: true } });
    return { entryMode: session.entryMode ?? 'OPEN', turns: await this.queueTurns(sessionId) };
  }

  private async ownSession(teacher: StaffActor, sessionId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, teacherId: teacher.id, kind: 'ISMA' },
      select: { status: true, entryMode: true, circleId: true, startedAt: true, scheduledAt: true },
    });
    if (!session || !session.circleId) throw notFound();
    return { ...session, circleId: session.circleId };
  }

  /** Changing the queue, or sending to it, only while the session runs. */
  private async liveSession(teacher: StaffActor, sessionId: string) {
    const session = await this.ownSession(teacher, sessionId);
    if (session.status !== 'IN_PROGRESS') throw new ApiError(409, 'session_not_live');
    return { ...session, entryMode: session.entryMode ?? 'OPEN' };
  }

  private async ownTurn(sessionId: string, turnId: string) {
    const turn = await this.prisma.ismaTurn.findFirst({ where: { id: turnId, sessionId }, select: { id: true, studentId: true } });
    if (!turn) throw notFound();
    return turn;
  }
}
