-- Review tracks: a plan of review and verification that ends with a final recitation or exam.
ALTER TYPE "TrackKind" ADD VALUE 'REVIEW';

CREATE TYPE "ReviewEndRule" AS ENUM ('DURATION', 'SCOPE', 'EITHER');
CREATE TYPE "ReviewFinalKind" AS ENUM ('RECITATION', 'EXAM');
CREATE TYPE "ReviewFailAction" AS ENUM ('RETAKE', 'EXTEND', 'RESTART');
CREATE TYPE "ReviewMoveMode" AS ENUM ('AUTO', 'EXAMINER');

ALTER TABLE "track_templates"
  ADD COLUMN "review_end_rule" "ReviewEndRule",
  ADD COLUMN "review_final_kinds" "ReviewFinalKind"[] NOT NULL DEFAULT ARRAY[]::"ReviewFinalKind"[],
  ADD COLUMN "review_pass_score" DECIMAL(3,1),
  ADD COLUMN "review_fail_action" "ReviewFailAction",
  ADD COLUMN "review_extend_days" SMALLINT,
  ADD COLUMN "review_move_mode" "ReviewMoveMode",
  ADD COLUMN "review_next_track_id" VARCHAR(32);

ALTER TABLE "track_templates" ADD CONSTRAINT "track_templates_review_next_track_id_fkey"
  FOREIGN KEY ("review_next_track_id") REFERENCES "track_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "student_plans" ADD COLUMN "review_ends_on" DATE;

ALTER TABLE "stage_exam_sessions" ADD COLUMN "final_kind" "ReviewFinalKind";
ALTER TABLE "stage_exams" ADD COLUMN "final_kind" "ReviewFinalKind";
