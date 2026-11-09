-- CreateEnum
CREATE TYPE "SegmentStatus" AS ENUM ('NEEDS_REVIEW', 'MASTERED');

-- CreateEnum
CREATE TYPE "LiveSessionKind" AS ENUM ('RECITATION', 'CORRECTION');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING_ADMIN', 'PENDING_TEACHER', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AnnouncementScope" ADD VALUE 'SCOPE';

-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'LATE';

-- DropForeignKey
ALTER TABLE "supervisor_circles" DROP CONSTRAINT "supervisor_circles_circle_id_fkey";

-- DropForeignKey
ALTER TABLE "supervisor_circles" DROP CONSTRAINT "supervisor_circles_supervisor_id_fkey";

-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "scope_id" VARCHAR(32);

-- AlterTable
ALTER TABLE "circles" ADD COLUMN     "capacity" SMALLINT NOT NULL DEFAULT 25,
ADD COLUMN     "scope_id" VARCHAR(32) NOT NULL;

-- AlterTable
ALTER TABLE "evaluations" ADD COLUMN     "attendance" "AttendanceStatus",
ADD COLUMN     "circle_id" VARCHAR(32),
ADD COLUMN     "from_ayah" SMALLINT,
ADD COLUMN     "segment_status" "SegmentStatus",
ADD COLUMN     "surah" SMALLINT,
ADD COLUMN     "to_ayah" SMALLINT,
ALTER COLUMN "score" DROP NOT NULL;

-- AlterTable
ALTER TABLE "live_sessions" ADD COLUMN     "kind" "LiveSessionKind" NOT NULL DEFAULT 'RECITATION',
ADD COLUMN     "notes" VARCHAR(2000);

-- AlterTable
ALTER TABLE "staff_credentials" ADD COLUMN     "totp_last_step" INTEGER,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "description" VARCHAR(1000),
ADD COLUMN     "due_at" TIMESTAMPTZ,
ADD COLUMN     "student_id" VARCHAR(32);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "scope_id" VARCHAR(32);

-- DropTable
DROP TABLE "supervisor_circles";

-- CreateTable
CREATE TABLE "scopes" (
    "id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_requests" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "from_circle_id" VARCHAR(32),
    "to_circle_id" VARCHAR(32) NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING_ADMIN',
    "requested_by_id" VARCHAR(32),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "transfer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scopes_name_key" ON "scopes"("name");

-- CreateIndex
CREATE INDEX "transfer_requests_status_idx" ON "transfer_requests"("status");

-- CreateIndex
CREATE INDEX "transfer_requests_to_circle_id_status_idx" ON "transfer_requests"("to_circle_id", "status");

-- CreateIndex
CREATE INDEX "transfer_requests_student_id_idx" ON "transfer_requests"("student_id");

-- CreateIndex
CREATE INDEX "announcements_scope_id_published_at_idx" ON "announcements"("scope_id", "published_at");

-- CreateIndex
CREATE INDEX "circles_scope_id_idx" ON "circles"("scope_id");

-- CreateIndex
CREATE INDEX "evaluations_circle_id_created_at_idx" ON "evaluations"("circle_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circles" ADD CONSTRAINT "circles_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_from_circle_id_fkey" FOREIGN KEY ("from_circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_to_circle_id_fkey" FOREIGN KEY ("to_circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A student has at most one transfer in progress.
CREATE UNIQUE INDEX "transfer_requests_one_open_key"
  ON "transfer_requests" ("student_id") WHERE "status" IN ('PENDING_ADMIN', 'PENDING_TEACHER');

ALTER TABLE "circles" ADD CONSTRAINT "circles_capacity_check" CHECK ("capacity" BETWEEN 1 AND 200);

-- A one-time task has a due date, and a daily one has none.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_due_check"
  CHECK (("recurrence" = 'ONCE' AND "due_at" IS NOT NULL) OR ("recurrence" = 'DAILY' AND "due_at" IS NULL));
