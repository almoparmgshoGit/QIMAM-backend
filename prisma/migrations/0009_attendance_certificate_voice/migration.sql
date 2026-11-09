-- One attendance-sheet row per student per day. Null on recitations, which Postgres doesn't count as duplicates.
ALTER TABLE "evaluations" ADD COLUMN "attendance_on" DATE;
CREATE UNIQUE INDEX "evaluations_student_id_attendance_on_key" ON "evaluations"("student_id", "attendance_on");

-- The date printed on a certificate. It stays fixed however the plan row changes later.
ALTER TABLE "student_plans" ADD COLUMN "completed_at" TIMESTAMPTZ;
UPDATE "student_plans" SET "completed_at" = "updated_at" WHERE "status" = 'COMPLETED';
