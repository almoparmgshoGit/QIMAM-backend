/**
 * The dedupe keys of support notifications. They carry the conversation's id, so a notification, or the push that
 * announces it, can open that conversation directly.
 */
export const supportReplyKey = (ticketId: string, messageId: string) => `support-reply:${ticketId}:${messageId}`;
export const supportNewKey = (ticketId: string) => `support-new:${ticketId}`;

export const isSupportKey = (key: string | null | undefined): key is string => Boolean(key?.startsWith('support-'));

/** The conversation a support notification is about, or null for any other notification. */
export const supportTicketOf = (key: string | null | undefined): string | null => (isSupportKey(key) ? (key.split(':')[1] ?? null) : null);
