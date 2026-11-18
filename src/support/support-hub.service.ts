import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** Which side of a conversation a connection belongs to. */
export type SupportSide = 'REQUESTER' | 'SUPPORT';

export type SupportEvent =
  | { type: 'ready' }
  | { type: 'message'; ticketId: string; message: unknown }
  | { type: 'ticket'; ticket: unknown }
  | { type: 'error'; code: string };

export interface SupportPeer {
  send(event: SupportEvent): void;
  close(code?: number, reason?: string): void;
}

export interface SupportMember {
  userId: string;
  side: SupportSide;
  peer: SupportPeer;
}

interface Ticket {
  userId: string;
  side: SupportSide;
  expiresAt: number;
}

const TICKET_TTL_MS = 60_000;
/** Tabs and phones one person may keep open at once. */
const MAX_CONNECTIONS_PER_USER = 10;

/**
 * Who is listening for support conversations right now. Nothing is stored here: a message is saved first and
 * only then announced, so a missed announcement costs only the live update, never the message. Lives in this
 * process's memory, which fits one server. More than one needs a shared channel.
 */
@Injectable()
export class SupportHub {
  private readonly tickets = new Map<string, Ticket>();
  private readonly requesters = new Map<string, Set<SupportPeer>>();
  private readonly support = new Map<string, Set<SupportPeer>>();

  /** Works once and briefly. A socket proves who it is with this, so it never needs a cookie or a long-lived token. */
  issue(userId: string, side: SupportSide): { ticket: string } {
    const now = Date.now();
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(value);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { userId, side, expiresAt: now + TICKET_TTL_MS });
    return { ticket };
  }

  redeem(value: string): Ticket | null {
    const found = this.tickets.get(value);
    if (!found) return null;
    this.tickets.delete(value);
    return found.expiresAt > Date.now() ? found : null;
  }

  join({ userId, side, peer }: SupportMember): void {
    const pool = side === 'SUPPORT' ? this.support : this.requesters;
    const peers = pool.get(userId) ?? new Set();
    pool.set(userId, peers);
    // The oldest connection gives way, as a forgotten tab would.
    if (peers.size >= MAX_CONNECTIONS_PER_USER) {
      const oldest = peers.values().next().value!;
      peers.delete(oldest);
      oldest.close(4001, 'replaced');
    }
    peers.add(peer);
    peer.send({ type: 'ready' });
  }

  leave({ userId, side, peer }: SupportMember): void {
    const pool = side === 'SUPPORT' ? this.support : this.requesters;
    const peers = pool.get(userId);
    if (!peers) return;
    peers.delete(peer);
    if (peers.size === 0) pool.delete(userId);
  }

  /** Every person connected now, for checking they may still listen. */
  members(): { userId: string; side: SupportSide }[] {
    return [
      ...[...this.requesters.keys()].map((userId) => ({ userId, side: 'REQUESTER' as const })),
      ...[...this.support.keys()].map((userId) => ({ userId, side: 'SUPPORT' as const })),
    ];
  }

  /** Closes every connection of someone who may no longer listen: suspended, or no longer on support. */
  disconnect(userId: string, side: SupportSide): void {
    const pool = side === 'SUPPORT' ? this.support : this.requesters;
    for (const peer of pool.get(userId) ?? []) peer.close(4003, 'revoked');
    pool.delete(userId);
  }

  toRequester(userId: string, event: SupportEvent): void {
    for (const peer of this.requesters.get(userId) ?? []) peer.send(event);
  }

  toSupport(event: SupportEvent): void {
    for (const peers of this.support.values()) for (const peer of peers) peer.send(event);
  }
}
