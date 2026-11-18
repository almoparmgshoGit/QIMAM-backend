import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { type SupportEvent, SupportHub, type SupportMember } from './support-hub.service.js';
import { SupportService } from './support.service.js';

const JOIN_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/** How often those listening are checked against the database, so a suspension or a lost permission ends it. */
const RECHECK_MS = 60_000;
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_LIMIT = 30;

const joinSchema = z.strictObject({ type: z.literal('join'), ticket: z.string().min(1).max(100) });

/**
 * Live updates for support conversations. It only announces: messages are sent and saved over HTTP, where they
 * are validated and rate limited, and the socket tells both sides they arrived. Identity comes only from a
 * one-time ticket, which the HTTP routes issue to a signed-in requester or support staff member.
 */
@WebSocketGateway({ path: '/v1/support', maxPayload: 4 * 1024 })
export class SupportGateway implements OnGatewayConnection, OnModuleDestroy {
  private readonly logger = new Logger('SupportGateway');
  private readonly alive = new Map<WebSocket, boolean>();
  private readonly heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
  private readonly recheck = setInterval(() => void this.recheckMembers().catch((error: unknown) => this.logger.warn(String(error))), RECHECK_MS);

  constructor(
    private readonly hub: SupportHub,
    private readonly support: SupportService,
  ) {
    this.heartbeat.unref();
    this.recheck.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.recheck);
  }

  handleConnection(socket: WebSocket): void {
    let member: SupportMember | null = null;
    let windowStart = Date.now();
    let messages = 0;

    const fail = (code: string) => {
      send(socket, { type: 'error', code });
      socket.close(4000, code);
    };

    const joinTimer = setTimeout(() => fail('join_timeout'), JOIN_TIMEOUT_MS);

    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(joinTimer);
      this.alive.delete(socket);
      if (member) this.hub.leave(member);
    });

    socket.on('message', (raw, isBinary) => {
      const now = Date.now();
      if (now - windowStart > FLOOD_WINDOW_MS) {
        windowStart = now;
        messages = 0;
      }
      if (++messages > FLOOD_LIMIT) return fail('too_many_messages');
      if (isBinary) return fail('invalid_message');

      const message = joinSchema.safeParse(parseJson(raw.toString()));
      if (!message.success) return fail('invalid_message');
      if (member) return fail('already_joined');

      const ticket = this.hub.redeem(message.data.ticket);
      if (!ticket) return fail('invalid_ticket');
      clearTimeout(joinTimer);
      member = {
        userId: ticket.userId,
        side: ticket.side,
        peer: { send: (event) => send(socket, event), close: (code = 1000, reason) => socket.close(code, reason) },
      };
      this.hub.join(member);
    });
  }

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

  private async recheckMembers(): Promise<void> {
    const members = this.hub.members();
    const allowed = await this.support.allowedListeners(members);
    for (const { userId, side } of members) {
      if (!allowed.has(`${side}:${userId}`)) this.hub.disconnect(userId, side);
    }
  }
}

function send(socket: WebSocket, event: SupportEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
