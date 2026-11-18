import type { OnModuleDestroy } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { type Member, type RoomMessage, type VoiceRole, VoiceService } from './voice.service.js';

const JOIN_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_LIMIT = 300;

const iceSchema = z.strictObject({
  candidate: z.string().max(2000),
  sdpMid: z.string().max(100).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(100).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

const signalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('offer'), sdp: z.string().max(32_000) }),
  z.strictObject({ kind: z.literal('answer'), sdp: z.string().max(32_000) }),
  z.strictObject({ kind: z.literal('ice'), candidate: iceSchema }),
]);

const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('join'), ticket: z.string().min(1).max(100) }),
  // `to` is the student a teacher's signal is for, in a room of many. Ids are nanoids.
  z.strictObject({ type: z.literal('signal'), data: signalSchema, to: z.string().min(1).max(40).optional() }),
  z.strictObject({ type: z.literal('mute'), muted: z.boolean() }),
]);

/** The teacher always offers and the student answers, so the two never start negotiating at once. */
const FORBIDDEN_SIGNAL: Record<VoiceRole, 'offer' | 'answer'> = { TEACHER: 'answer', STUDENT: 'offer' };

/** Setting up a voice call. Identity comes only from a one-time ticket, and every message is checked. */
@WebSocketGateway({ path: '/v1/voice', maxPayload: 64 * 1024 })
export class VoiceGateway implements OnGatewayConnection, OnModuleDestroy {
  private readonly alive = new Map<WebSocket, boolean>();
  private readonly heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);

  constructor(private readonly voice: VoiceService) {
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeat);
  }

  handleConnection(socket: WebSocket): void {
    let member: Member | null = null;
    let windowStart = Date.now();
    let messages = 0;

    const fail = (code: string) => {
      send(socket, { type: 'error', code });
      socket.close(4000, code);
    };

    // A connection that never proves who it is doesn't get to hold a place on the server.
    const joinTimer = setTimeout(() => fail('join_timeout'), JOIN_TIMEOUT_MS);

    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(joinTimer);
      this.alive.delete(socket);
      if (member) this.voice.leave(member);
    });

    socket.on('message', (raw, isBinary) => {
      const now = Date.now();
      if (now - windowStart > FLOOD_WINDOW_MS) {
        windowStart = now;
        messages = 0;
      }
      if (++messages > FLOOD_LIMIT) return fail('too_many_messages');
      if (isBinary) return fail('invalid_message');

      const message = messageSchema.safeParse(parseJson(raw.toString()));
      if (!message.success) return fail('invalid_message');

      if (message.data.type === 'join') {
        if (member) return fail('already_joined');
        const ticket = this.voice.redeem(message.data.ticket);
        if (!ticket) return fail('invalid_ticket');
        clearTimeout(joinTimer);
        member = {
          roomId: ticket.roomId,
          role: ticket.role,
          studentId: ticket.studentId,
          peer: { send: (outgoing) => send(socket, outgoing), close: () => socket.close(1000) },
        };
        this.voice.join(member);
        return;
      }

      if (!member) return fail('not_joined');
      if (message.data.type === 'mute') {
        this.voice.setMuted(member, message.data.muted);
        return;
      }
      if (message.data.data.kind === FORBIDDEN_SIGNAL[member.role]) return fail('invalid_message');
      // Only the teacher addresses one student. A student's signals always go to the teacher.
      if (member.role === 'STUDENT' && message.data.to) return fail('invalid_message');
      this.voice.signal(member, message.data.data, message.data.to);
    });
  }

  /** Finds phones that lost their network without saying goodbye, so the other side learns they left. */
  private checkAlive(): void {
    for (const [socket, alive] of this.alive) {
      if (!alive) {
        socket.terminate();
        continue;
      }
      this.alive.set(socket, false);
      socket.ping();
    }
  }
}

function send(socket: WebSocket, message: RoomMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
