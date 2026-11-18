-- A track's length is entered as a number of months. The words students read are made from it.
ALTER TABLE "track_templates" ADD COLUMN "duration_months" SMALLINT;

-- Reads the lengths already written in words, such as «3 سنوات» or «4 سنوات ونصف».
-- A length that can't be read stays empty, and is asked for the next time the track is edited.
UPDATE "track_templates"
SET "duration_months" = NULLIF(
  CASE
    WHEN "duration" ~ 'سنتان|سنتين' THEN 24
    WHEN "duration" ~ '\d+\s*(سنة|سنوات|سنين|عام|أعوام)' THEN substring("duration" from '(\d+)\s*(?:سنة|سنوات|سنين|عام|أعوام)')::int * 12
    WHEN "duration" ~ '(سنة|عام)' THEN 12
    ELSE 0
  END
  + CASE WHEN "duration" ~ '(سن|عام|أعوام).*نصف' THEN 6 ELSE 0 END
  + COALESCE(substring("duration" from '(\d+)\s*(?:شهر|شهور|أشهر|اشهر)')::int, 0),
  0
);
