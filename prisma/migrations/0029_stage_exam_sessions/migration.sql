-- CreateEnum
CREATE TYPE "StageExamMode" AS ENUM ('OFF', 'REQUIRED', 'BLOCKING');
CREATE TYPE "StageExamSessionStatus" AS ENUM ('WAITING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterTable: existing tracks test each seventh, without holding back new memorization.
ALTER TABLE "track_templates" ADD COLUMN "stage_exam_mode" "StageExamMode" NOT NULL DEFAULT 'REQUIRED';

-- AlterTable: a teacher's offered time can be booked by a stage exam as well as an admission test.
ALTER TABLE "admission_slots" ADD COLUMN "stage_session_id" VARCHAR(32);
ALTER TABLE "admission_slots" ADD CONSTRAINT "admission_slots_one_booking_check" CHECK ("test_id" IS NULL OR "stage_session_id" IS NULL);

-- CreateTable
CREATE TABLE "stage_exam_sessions" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32),
    "stage" SMALLINT NOT NULL,
    "examiner_id" VARCHAR(32),
    "scheduled_at" TIMESTAMPTZ,
    "status" "StageExamSessionStatus" NOT NULL DEFAULT 'WAITING',
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "exam_id" VARCHAR(32),
    "retake" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "stage_exam_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stage_exam_sessions_stage_check" CHECK ("stage" BETWEEN 1 AND 7)
);

-- CreateIndex
CREATE UNIQUE INDEX "admission_slots_stage_session_id_key" ON "admission_slots"("stage_session_id");
CREATE UNIQUE INDEX "stage_exam_sessions_exam_id_key" ON "stage_exam_sessions"("exam_id");
CREATE INDEX "stage_exam_sessions_student_id_status_idx" ON "stage_exam_sessions"("student_id", "status");
CREATE INDEX "stage_exam_sessions_examiner_id_status_idx" ON "stage_exam_sessions"("examiner_id", "status");
CREATE INDEX "stage_exam_sessions_circle_id_status_idx" ON "stage_exam_sessions"("circle_id", "status");
-- One open exam per student and seventh, so finishing it twice at once can't open two.
CREATE UNIQUE INDEX "stage_exam_sessions_one_open_key" ON "stage_exam_sessions"("student_id", "stage") WHERE "status" IN ('WAITING', 'SCHEDULED', 'IN_PROGRESS');

-- AddForeignKey
ALTER TABLE "admission_slots" ADD CONSTRAINT "admission_slots_stage_session_id_fkey" FOREIGN KEY ("stage_session_id") REFERENCES "stage_exam_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stage_exam_sessions" ADD CONSTRAINT "stage_exam_sessions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_exam_sessions" ADD CONSTRAINT "stage_exam_sessions_examiner_id_fkey" FOREIGN KEY ("examiner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stage_exam_sessions" ADD CONSTRAINT "stage_exam_sessions_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stage_exam_sessions" ADD CONSTRAINT "stage_exam_sessions_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "stage_exams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
