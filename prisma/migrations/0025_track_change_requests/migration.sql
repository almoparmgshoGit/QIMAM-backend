-- CreateEnum
CREATE TYPE "TrackChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "track_change_requests" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "from_track_id" VARCHAR(32),
    "to_track_id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32),
    "reason" VARCHAR(500) NOT NULL,
    "status" "TrackChangeStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" VARCHAR(32),
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "track_change_requests_student_id_status_idx" ON "track_change_requests"("student_id", "status");
CREATE INDEX "track_change_requests_circle_id_status_idx" ON "track_change_requests"("circle_id", "status");

-- One pending request per student, whatever arrives at the same moment.
CREATE UNIQUE INDEX "track_change_requests_one_pending_key" ON "track_change_requests"("student_id") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "track_change_requests" ADD CONSTRAINT "track_change_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "track_change_requests" ADD CONSTRAINT "track_change_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "track_change_requests" ADD CONSTRAINT "track_change_requests_from_track_id_fkey" FOREIGN KEY ("from_track_id") REFERENCES "track_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "track_change_requests" ADD CONSTRAINT "track_change_requests_to_track_id_fkey" FOREIGN KEY ("to_track_id") REFERENCES "track_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "track_change_requests" ADD CONSTRAINT "track_change_requests_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
