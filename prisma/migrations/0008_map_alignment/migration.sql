-- Aligns the program with the updated functional map.

-- The live tadabbur lesson is one of the gate's steps.
ALTER TABLE "surah_gates" ADD COLUMN "lesson_attended_at" TIMESTAMPTZ;

-- A student writes their week's review surahs in their own words.
ALTER TABLE "day_completions" ALTER COLUMN "detail" TYPE VARCHAR(300);

UPDATE "track_templates" SET "duration" = '4 سنوات ونصف' WHERE "code" = 'steady';

-- 120 days: one surah a day across the whole week, with no extra days between surahs.
UPDATE "track_templates"
SET "wird_days" = ARRAY[0,1,2,3,4,5,6], "consolidation_days" = 0
WHERE "code" = 'stabilization';
