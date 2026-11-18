-- A track memorizes the whole Quran or a juz' range, beginning from Al-Baqarah, from the end of the mushaf, or from Al-Kahf.
CREATE TYPE "MemorizationOrder" AS ENUM ('FORWARD', 'BACKWARD', 'KAHF');

-- The tracks so far all begin at Al-Kahf.
ALTER TABLE "track_templates"
  ADD COLUMN "memorization_order" "MemorizationOrder" NOT NULL DEFAULT 'KAHF',
  ADD COLUMN "juz_from" SMALLINT,
  ADD COLUMN "juz_to" SMALLINT;

-- Plans so far cover the whole Quran.
ALTER TABLE "student_plans" ADD COLUMN "page_range" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
