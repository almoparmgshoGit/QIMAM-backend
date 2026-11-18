-- The admission recitation test: a teacher the supervisor assigns, a time, and its own voice room.
CREATE TYPE "AdmissionTestStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

CREATE TABLE "admission_tests" (
  "id" VARCHAR(32) NOT NULL,
  "student_id" VARCHAR(32) NOT NULL,
  "teacher_id" VARCHAR(32),
  "scheduled_at" TIMESTAMPTZ,
  "status" "AdmissionTestStatus" NOT NULL DEFAULT 'SCHEDULED',
  "started_at" TIMESTAMPTZ,
  "ended_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "admission_tests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admission_tests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admission_tests_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "admission_tests_student_id_status_idx" ON "admission_tests"("student_id", "status");
CREATE INDEX "admission_tests_teacher_id_status_idx" ON "admission_tests"("teacher_id", "status");

-- Times a teacher offers, which a student books when the settings let her choose.
CREATE TABLE "admission_slots" (
  "id" VARCHAR(32) NOT NULL,
  "teacher_id" VARCHAR(32) NOT NULL,
  "starts_at" TIMESTAMPTZ NOT NULL,
  "test_id" VARCHAR(32),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "admission_slots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admission_slots_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "admission_slots_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "admission_tests"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "admission_slots_test_id_key" ON "admission_slots"("test_id");
CREATE UNIQUE INDEX "admission_slots_teacher_id_starts_at_key" ON "admission_slots"("teacher_id", "starts_at");
