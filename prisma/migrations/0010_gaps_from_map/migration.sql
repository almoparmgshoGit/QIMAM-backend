-- The recitation test a student passes before starting. Everyone already here counts as accepted.
CREATE TYPE "AdmissionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
ALTER TABLE "users"
  ADD COLUMN "admission_status" "AdmissionStatus" NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN "admission_score" DECIMAL(4,1),
  ADD COLUMN "admission_note" VARCHAR(500),
  ADD COLUMN "admission_decided_at" TIMESTAMPTZ,
  -- Reminders follow the student's own clock. Null falls back to Riyadh.
  ADD COLUMN "time_zone" VARCHAR(60),
  ADD COLUMN "reminder_minutes" SMALLINT NOT NULL DEFAULT 1200;
CREATE INDEX "users_admission_status_idx" ON "users"("admission_status");

-- The student says they attended the live lesson; the teacher confirms it.
ALTER TABLE "surah_gates" ADD COLUMN "lesson_confirmed_at" TIMESTAMPTZ;
UPDATE "surah_gates" SET "lesson_confirmed_at" = "lesson_attended_at" WHERE "lesson_attended_at" IS NOT NULL;

-- A student's own review of a recited segment, which moves its next date further out.
CREATE TABLE "segment_reviews" (
  "evaluation_id" VARCHAR(32) NOT NULL,
  "done_on" DATE NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "segment_reviews_pkey" PRIMARY KEY ("evaluation_id", "done_on"),
  CONSTRAINT "segment_reviews_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Encouragement was off for every new student by mistake. The map sends it to all.
UPDATE "notification_preferences" SET "enabled" = true WHERE "type" = 'ENCOURAGEMENT' AND "enabled" = false;
