-- Motivational messages from the administration to teachers, sent at once or scheduled.
CREATE TABLE "teacher_incentives" (
    "id" VARCHAR(32) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "teacher_id" VARCHAR(32),
    "send_at" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMPTZ,
    "recipients" INTEGER,
    "author_id" VARCHAR(32),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_incentives_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "teacher_incentives_sent_at_send_at_idx" ON "teacher_incentives"("sent_at", "send_at");

ALTER TABLE "teacher_incentives" ADD CONSTRAINT "teacher_incentives_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
