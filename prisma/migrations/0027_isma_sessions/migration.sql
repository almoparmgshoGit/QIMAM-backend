-- AlterEnum
ALTER TYPE "LiveSessionKind" ADD VALUE 'ISMA';

-- CreateEnum
CREATE TYPE "IsmaEntryMode" AS ENUM ('OPEN', 'TURN');
CREATE TYPE "IsmaTurnStatus" AS ENUM ('WAITING', 'ACTIVE', 'DONE');
CREATE TYPE "IsmaMarkKind" AS ENUM ('MISTAKE', 'WARNING');

-- AlterTable
ALTER TABLE "live_sessions" ADD COLUMN "entry_mode" "IsmaEntryMode";

-- CreateTable
CREATE TABLE "isma_turns" (
    "id" VARCHAR(32) NOT NULL,
    "session_id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "position" SMALLINT NOT NULL,
    "status" "IsmaTurnStatus" NOT NULL DEFAULT 'WAITING',
    "attendance" "AttendanceStatus",
    "joined_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "isma_turns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "isma_turns_position_check" CHECK ("position" >= 1)
);

CREATE TABLE "isma_marks" (
    "id" VARCHAR(32) NOT NULL,
    "turn_id" VARCHAR(32) NOT NULL,
    "kind" "IsmaMarkKind" NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "isma_marks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "isma_turns_session_id_student_id_key" ON "isma_turns"("session_id", "student_id");
CREATE INDEX "isma_turns_session_id_position_idx" ON "isma_turns"("session_id", "position");
CREATE INDEX "isma_marks_turn_id_created_at_idx" ON "isma_marks"("turn_id", "created_at");
-- One student recites at a time in a session.
CREATE UNIQUE INDEX "isma_turns_one_active_key" ON "isma_turns"("session_id") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "isma_turns" ADD CONSTRAINT "isma_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "isma_turns" ADD CONSTRAINT "isma_turns_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "isma_marks" ADD CONSTRAINT "isma_marks_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "isma_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An isma session evaluates each of its students once, where a one-to-one session has a single evaluation.
DROP INDEX "evaluations_one_per_session_key";
CREATE UNIQUE INDEX "evaluations_one_per_session_key" ON "evaluations" ("live_session_id", "student_id") WHERE "live_session_id" IS NOT NULL;
