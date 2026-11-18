import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type VoiceRole = 'TEACHER' | 'STUDENT';

/** Where a student stands in an isma session's queue, as she sees it. */
export interface IsmaState {
  position: number;
  /** Students still waiting before her. */
  ahead: number;
  /** Nobody waits before her: she recites as soon as the current turn ends. */
  next: boolean;
  status: 'WAITING' | 'ACTIVE' | 'DONE';
  entryMode: 'OPEN' | 'TURN';
}

/**
 * Only what the other side needs. Nothing passing through a room is stored, and no audio reaches this server.
 * The teacher's copies carry `peerId`, the student they concern, since an isma room has many. A student only
 * ever talks to the teacher, so hers never need it.
 */
export type RoomMessage =
  | { type: 'joined'; role: VoiceRole; peerPresent: boolean; peerMuted: boolean; peers?: { id: string; muted: boolean }[] }
  | { type: 'peer-joined'; peerId?: string }
  | { type: 'peer-left'; peerId?: string }
  | { type: 'peer-mute'; muted: boolean; peerId?: string }
  | { type: 'signal'; data: unknown; peerId?: string }
  | { type: 'session-ended' }
  | { type: 'isma-state'; state: IsmaState }
  | { type: 'isma-notice'; title: string; body: string }
  | { type: 'error'; code: string };

export interface RoomPeer {
  send(message: RoomMessage): void;
  close(): void;
}

export interface Ticket {
  /** A session's id, or `admission:` or `stage-exam:` and a test's id. Ids are nanoids, so these never collide. */
  roomId: string;
  role: VoiceRole;
  /** The student's own id. A room tells its students apart by it. */
  studentId: string | null;
  expiresAt: number;
}

export interface Member {
  roomId: string;
  role: VoiceRole;
  studentId: string | null;
  peer: RoomPeer;
}

interface Room {
  teacher?: RoomPeer;
  teacherMuted: boolean;
  students: Map<string, { peer: RoomPeer; muted: boolean }>;
}

type JoinListener = (roomId: string, studentId: string) => void;

const TICKET_TTL_MS = 60_000;
const TURN_CREDENTIAL_TTL_S = 4 * 60 * 60;
const admissionRoom = (testId: string) => `admission:${testId}`;
const stageExamRoom = (sessionId: string) => `stage-exam:${sessionId}`;

/**
 * The call's setup. The audio itself goes directly between each student's device and the teacher's over WebRTC,
 * or through TURN where a network blocks that: a star around the teacher, never student to student. Rooms and
 * tickets live in this process's memory, which fits one server. More than one needs shared storage.
 */
@Injectable()
export class VoiceService {
  private readonly tickets = new Map<string, Ticket>();
  private readonly rooms = new Map<string, Room>();
  private readonly joinListeners: JoinListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Told each time a student enters a room, as the isma queue is to record her attendance. */
  onStudentJoined(listener: JoinListener): void {
    this.joinListeners.push(listener);
  }

  async ticketForStudent(studentId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, OR: [{ studentId }, { kind: 'ISMA', turns: { some: { studentId } } }] },
      select: { status: true, kind: true, entryMode: true, turns: { where: { studentId }, select: { status: true } } },
    });
    if (!session) throw new ApiError(404, 'not_found');
    // A room that admits each student for her turn only, keeps everyone else out until then.
    const live = session.status === 'IN_PROGRESS';
    if (live && session.kind === 'ISMA' && session.entryMode === 'TURN' && session.turns[0]?.status !== 'ACTIVE') {
      throw new ApiError(403, 'turn_not_started');
    }
    return this.issue(sessionId, 'STUDENT', session.status, studentId);
  }

  async ticketForTeacher(teacherId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, teacherId },
      select: { status: true, studentId: true, kind: true },
    });
    if (!session) throw new ApiError(404, 'not_found');
    // A circle session other than isma has no voice: the room is for one student, or for an isma queue.
    if (!session.studentId && session.kind !== 'ISMA') throw new ApiError(409, 'group_voice_unsupported');
    return this.issue(sessionId, 'TEACHER', session.status, null);
  }

  /** The admission test's own room, apart from the teacher's sessions. */
  async ticketForAdmissionStudent(studentId: string, testId: string) {
    const test = await this.prisma.admissionTest.findFirst({ where: { id: testId, studentId }, select: { status: true } });
    if (!test) throw new ApiError(404, 'not_found');
    return this.issue(admissionRoom(testId), 'STUDENT', test.status, studentId);
  }

  async ticketForAdmissionTeacher(teacherId: string, testId: string) {
    const test = await this.prisma.admissionTest.findFirst({ where: { id: testId, teacherId }, select: { status: true } });
    if (!test) throw new ApiError(404, 'not_found');
    return this.issue(admissionRoom(testId), 'TEACHER', test.status, null);
  }

  endAdmissionRoom(testId: string): void {
    this.endRoom(admissionRoom(testId));
  }

  /** A stage exam's room: the student and the teacher examining her, one to one. */
  async ticketForStageExamStudent(studentId: string, sessionId: string) {
    const exam = await this.prisma.stageExamSession.findFirst({ where: { id: sessionId, studentId }, select: { status: true } });
    if (!exam) throw new ApiError(404, 'not_found');
    return this.issue(stageExamRoom(sessionId), 'STUDENT', exam.status, studentId);
  }

  async ticketForStageExamTeacher(examinerId: string, sessionId: string) {
    const exam = await this.prisma.stageExamSession.findFirst({ where: { id: sessionId, examinerId }, select: { status: true } });
    if (!exam) throw new ApiError(404, 'not_found');
    return this.issue(stageExamRoom(sessionId), 'TEACHER', exam.status, null);
  }

  endStageExamRoom(sessionId: string): void {
    this.endRoom(stageExamRoom(sessionId));
  }

  /** Works once. A socket proves who it is with this, so it never needs a cookie or a long-lived token. */
  redeem(ticket: string): Ticket | null {
    const found = this.tickets.get(ticket);
    if (!found) return null;
    this.tickets.delete(ticket);
    return found.expiresAt > Date.now() ? found : null;
  }

  /** A newer connection of the same person replaces the older one, as after a dropped network. */
  join({ roomId, role, studentId, peer }: Member): void {
    const room: Room = this.rooms.get(roomId) ?? { teacherMuted: false, students: new Map() };
    this.rooms.set(roomId, room);

    if (role === 'TEACHER') {
      const previous = room.teacher;
      room.teacher = peer;
      room.teacherMuted = false;
      previous?.close();
      const peers = [...room.students].map(([id, { muted }]) => ({ id, muted }));
      peer.send({ type: 'joined', role, peerPresent: peers.length > 0, peerMuted: peers.some(({ muted }) => muted), peers });
      for (const { peer: student } of room.students.values()) student.send({ type: 'peer-joined' });
      return;
    }

    const id = studentId!;
    const previous = room.students.get(id);
    room.students.set(id, { peer, muted: false });
    previous?.peer.close();
    peer.send({ type: 'joined', role, peerPresent: Boolean(room.teacher), peerMuted: room.teacherMuted });
    room.teacher?.send({ type: 'peer-joined', peerId: id });
    for (const listener of this.joinListeners) listener(roomId, id);
  }

  leave({ roomId, role, studentId, peer }: Member): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    // A replaced connection closing late must not remove its replacement.
    if (role === 'TEACHER') {
      if (room.teacher !== peer) return;
      delete room.teacher;
      room.teacherMuted = false;
      for (const { peer: student } of room.students.values()) student.send({ type: 'peer-left' });
    } else {
      if (room.students.get(studentId!)?.peer !== peer) return;
      room.students.delete(studentId!);
      room.teacher?.send({ type: 'peer-left', peerId: studentId! });
    }
    if (!room.teacher && room.students.size === 0) this.rooms.delete(roomId);
  }

  setMuted({ roomId, role, studentId }: Member, muted: boolean): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (role === 'TEACHER') {
      room.teacherMuted = muted;
      for (const { peer } of room.students.values()) peer.send({ type: 'peer-mute', muted });
      return;
    }
    const student = room.students.get(studentId!);
    if (student) student.muted = muted;
    room.teacher?.send({ type: 'peer-mute', muted, peerId: studentId! });
  }

  /**
   * A student's signal goes to the teacher. The teacher's goes to the student named in `to`, or to every student
   * where it names none, which is how the one-to-one rooms work.
   */
  signal({ roomId, role, studentId }: Member, data: unknown, to?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (role === 'STUDENT') {
      room.teacher?.send({ type: 'signal', data, peerId: studentId! });
      return;
    }
    if (to) room.students.get(to)?.peer.send({ type: 'signal', data });
    else for (const { peer } of room.students.values()) peer.send({ type: 'signal', data });
  }

  /** The students in the room now. */
  present(roomId: string): Set<string> {
    return new Set(this.rooms.get(roomId)?.students.keys() ?? []);
  }

  sendToStudent(roomId: string, studentId: string, message: RoomMessage): void {
    this.rooms.get(roomId)?.students.get(studentId)?.peer.send(message);
  }

  /** The teacher ended the session, so it ends for everyone and nobody can come back in. */
  endRoom(roomId: string): void {
    for (const [value, ticket] of this.tickets) {
      if (ticket.roomId === roomId) this.tickets.delete(value);
    }
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    for (const peer of [room.teacher, ...[...room.students.values()].map(({ peer: student }) => student)]) {
      peer?.send({ type: 'session-ended' });
      peer?.close();
    }
  }

  private issue(roomId: string, role: VoiceRole, status: string, studentId: string | null) {
    if (status !== 'IN_PROGRESS') throw new ApiError(409, 'session_not_live');

    const now = Date.now();
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(value);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { roomId, role, studentId, expiresAt: now + TICKET_TTL_MS });
    return { ticket, iceServers: this.iceServers() };
  }

  /** TURN credentials expire on their own, so one taken from a device stops working within hours. */
  private iceServers() {
    const stun = this.config.getOrThrow<string[]>('STUN_URLS');
    const servers: { urls: string[]; username?: string; credential?: string }[] = stun.length > 0 ? [{ urls: stun }] : [];

    const turn = this.config.get<string[]>('TURN_URLS');
    const secret = this.config.get<string>('TURN_SECRET');
    if (turn && secret) {
      const username = String(Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_S);
      servers.push({ urls: turn, username, credential: createHmac('sha1', secret).update(username).digest('base64') });
    }
    return servers;
  }
}
