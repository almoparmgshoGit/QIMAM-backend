import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type VoiceRole = 'TEACHER' | 'STUDENT';

/** Only what the other side needs. Nothing passing through a room is stored, and no audio reaches this server. */
export type RoomMessage =
  | { type: 'joined'; role: VoiceRole; peerPresent: boolean; peerMuted: boolean }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'peer-mute'; muted: boolean }
  | { type: 'signal'; data: unknown }
  | { type: 'session-ended' }
  | { type: 'error'; code: string };

export interface RoomPeer {
  send(message: RoomMessage): void;
  close(): void;
}

interface Ticket {
  sessionId: string;
  role: VoiceRole;
  expiresAt: number;
}

interface Room {
  TEACHER?: RoomPeer;
  STUDENT?: RoomPeer;
  muted: Record<VoiceRole, boolean>;
}

const TICKET_TTL_MS = 60_000;
const TURN_CREDENTIAL_TTL_S = 4 * 60 * 60;
const other = (role: VoiceRole): VoiceRole => (role === 'TEACHER' ? 'STUDENT' : 'TEACHER');

/**
 * The call's setup. The audio itself goes directly between the two devices over WebRTC, or through
 * TURN where a network blocks that. Rooms and tickets live in this process's memory, which fits one
 * server. More than one needs shared storage.
 */
@Injectable()
export class VoiceService {
  private readonly tickets = new Map<string, Ticket>();
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async ticketForStudent(studentId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, studentId },
      select: { status: true },
    });
    if (!session) throw new ApiError(404, 'not_found');
    return this.issue(sessionId, 'STUDENT', session.status);
  }

  async ticketForTeacher(teacherId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, teacherId },
      select: { status: true, studentId: true },
    });
    if (!session) throw new ApiError(404, 'not_found');
    // A session for a whole circle is more than two people, which a direct call can't carry.
    if (!session.studentId) throw new ApiError(409, 'group_voice_unsupported');
    return this.issue(sessionId, 'TEACHER', session.status);
  }

  /** Works once. A socket proves who it is with this, so it never needs a cookie or a long-lived token. */
  redeem(ticket: string): Ticket | null {
    const found = this.tickets.get(ticket);
    if (!found) return null;
    this.tickets.delete(ticket);
    return found.expiresAt > Date.now() ? found : null;
  }

  /** A newer connection of the same person replaces the older one, as after a dropped network. */
  join(sessionId: string, role: VoiceRole, peer: RoomPeer): void {
    const room = this.rooms.get(sessionId) ?? { muted: { TEACHER: false, STUDENT: false } };
    this.rooms.set(sessionId, room);

    const previous = room[role];
    room[role] = peer;
    room.muted[role] = false;
    previous?.close();

    const opposite = room[other(role)];
    peer.send({ type: 'joined', role, peerPresent: Boolean(opposite), peerMuted: room.muted[other(role)] });
    opposite?.send({ type: 'peer-joined' });
  }

  leave(sessionId: string, role: VoiceRole, peer: RoomPeer): void {
    const room = this.rooms.get(sessionId);
    // A replaced connection closing late must not remove its replacement.
    if (room?.[role] !== peer) return;
    delete room[role];
    room.muted[role] = false;
    room[other(role)]?.send({ type: 'peer-left' });
    if (!room.TEACHER && !room.STUDENT) this.rooms.delete(sessionId);
  }

  relay(sessionId: string, from: VoiceRole, message: RoomMessage): void {
    const room = this.rooms.get(sessionId);
    if (message.type === 'peer-mute' && room) room.muted[from] = message.muted;
    room?.[other(from)]?.send(message);
  }

  /** The teacher ended the session, so it ends for everyone and nobody can come back in. */
  endRoom(sessionId: string): void {
    for (const [value, ticket] of this.tickets) {
      if (ticket.sessionId === sessionId) this.tickets.delete(value);
    }
    const room = this.rooms.get(sessionId);
    if (!room) return;
    this.rooms.delete(sessionId);
    for (const peer of [room.TEACHER, room.STUDENT]) {
      peer?.send({ type: 'session-ended' });
      peer?.close();
    }
  }

  private issue(sessionId: string, role: VoiceRole, status: string) {
    if (status !== 'IN_PROGRESS') throw new ApiError(409, 'session_not_live');

    const now = Date.now();
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(value);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { sessionId, role, expiresAt: now + TICKET_TTL_MS });
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
