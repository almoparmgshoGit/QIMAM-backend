-- A track sets its own daily steps, how many times each counted step runs, and its words of encouragement.
ALTER TABLE "track_templates"
  ADD COLUMN "wird_steps" JSONB,
  ADD COLUMN "repeat_target" SMALLINT NOT NULL DEFAULT 35,
  ADD COLUMN "review_target" SMALLINT NOT NULL DEFAULT 5,
  ADD COLUMN "encouragements" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "wird_progress" ADD COLUMN "review_count" SMALLINT NOT NULL DEFAULT 0;

-- Reviewing the previous portion used to be ticked, and is now counted. Whoever ticked it keeps it done.
UPDATE "wird_progress" SET "review_count" = 5 WHERE 0 = ANY("done_steps");
