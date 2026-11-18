-- The surah a memorization track begins at. Null begins at the order's own start.
ALTER TABLE "track_templates" ADD COLUMN "start_surah" SMALLINT;
