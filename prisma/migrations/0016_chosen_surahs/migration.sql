-- The Al-Kahf order is gone. A track memorizes from Al-Baqarah or from the end, over the whole Quran,
-- a juz' range, or surahs the administration chooses.

-- Tracks that began at Al-Kahf now begin at Al-Baqarah for students who start after this.
-- Students already on them keep their own copy of the order in their plans.
UPDATE "track_templates"
SET "memorization_order" = 'FORWARD', "surah_order" = ARRAY(SELECT generate_series(1, 114))
WHERE "memorization_order" = 'KAHF';

ALTER TYPE "MemorizationOrder" RENAME TO "MemorizationOrder_old";
CREATE TYPE "MemorizationOrder" AS ENUM ('FORWARD', 'BACKWARD');
ALTER TABLE "track_templates"
  ALTER COLUMN "memorization_order" DROP DEFAULT,
  ALTER COLUMN "memorization_order" TYPE "MemorizationOrder" USING "memorization_order"::text::"MemorizationOrder",
  ALTER COLUMN "memorization_order" SET DEFAULT 'FORWARD';
DROP TYPE "MemorizationOrder_old";

-- Surah numbers the administration chose. Empty when the track covers the whole Quran or a juz' range.
ALTER TABLE "track_templates" ADD COLUMN "selected_surahs" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
