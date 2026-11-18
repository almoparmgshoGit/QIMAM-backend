-- A track of chosen surahs can set a number of ayahs a day instead of half a page, a page or a surah.
ALTER TYPE "DailyUnit" ADD VALUE 'AYAHS';

ALTER TABLE "track_templates" ADD COLUMN "daily_ayahs" SMALLINT;

-- Chosen surahs have no direction and go in the mushaf's order. Plans already started keep their own copy.
UPDATE "track_templates"
SET "memorization_order" = 'FORWARD',
    "surah_order" = ARRAY(SELECT DISTINCT unnest("selected_surahs") ORDER BY 1)
WHERE cardinality("selected_surahs") > 0;
