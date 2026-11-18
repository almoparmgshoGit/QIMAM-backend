-- A track may split the day's portion into sessions, such as morning and evening. Null keeps the day whole.
ALTER TABLE "track_templates" ADD COLUMN "daily_sessions" SMALLINT;

-- The sessions of the current unit the student has finished.
ALTER TABLE "wird_progress" ADD COLUMN "done_sessions" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
