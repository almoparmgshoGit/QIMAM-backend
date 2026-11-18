-- Support conversations between students, teachers or supervisors and the administration.
CREATE TYPE "SupportCategory" AS ENUM ('TECHNICAL', 'ACCOUNT', 'PROGRAM', 'OTHER');

CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "support_tickets" (
    "id" VARCHAR(32) NOT NULL,
    "requester_id" VARCHAR(32) NOT NULL,
    "subject" VARCHAR(160) NOT NULL,
    "category" "SupportCategory" NOT NULL DEFAULT 'OTHER',
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "assignee_id" VARCHAR(32),
    "requester_unread" INTEGER NOT NULL DEFAULT 0,
    "support_unread" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_tickets_unread_not_negative" CHECK ("requester_unread" >= 0 AND "support_unread" >= 0)
);

CREATE TABLE "support_messages" (
    "id" VARCHAR(32) NOT NULL,
    "ticket_id" VARCHAR(32) NOT NULL,
    "author_id" VARCHAR(32),
    "from_support" BOOLEAN NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_tickets_requester_id_last_message_at_idx" ON "support_tickets"("requester_id", "last_message_at");

CREATE INDEX "support_tickets_status_last_message_at_idx" ON "support_tickets"("status", "last_message_at");

CREATE INDEX "support_tickets_assignee_id_idx" ON "support_tickets"("assignee_id");

CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
