-- Badges get a look (icon, emoji or picture), a colour, an audience, a rule for when they are given,
-- and who may give them by hand. Staff can now hold badges too.
CREATE TYPE "BadgeVisual" AS ENUM ('ICON', 'EMOJI', 'IMAGE');
CREATE TYPE "BadgeAudience" AS ENUM ('STUDENTS', 'STAFF', 'EVERYONE');
CREATE TYPE "BadgeTrigger" AS ENUM ('MANUAL', 'SURAH_PASSED', 'PAGES_MEMORIZED', 'WIRD_DAYS', 'TRACK_COMPLETED');

ALTER TABLE "badges"
  ADD COLUMN "visual" "BadgeVisual" NOT NULL DEFAULT 'ICON',
  ADD COLUMN "color" VARCHAR(7) NOT NULL DEFAULT '#B8860B',
  ADD COLUMN "audience" "BadgeAudience" NOT NULL DEFAULT 'STUDENTS',
  ADD COLUMN "trigger" "BadgeTrigger" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "threshold" INTEGER,
  ADD COLUMN "supervisor_can_award" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- The two automatic badges were found by these codes until now.
UPDATE "badges" SET "trigger" = 'SURAH_PASSED', "threshold" = 1, "supervisor_can_award" = false WHERE "code" = 'surahComplete';
UPDATE "badges" SET "trigger" = 'TRACK_COMPLETED', "supervisor_can_award" = false WHERE "code" = 'quranCompanion';

CREATE TABLE "badge_images" (
  "badge_id" VARCHAR(32) NOT NULL,
  "data" BYTEA NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "badge_images_pkey" PRIMARY KEY ("badge_id"),
  CONSTRAINT "badge_images_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "student_badges" ADD COLUMN "note" VARCHAR(200);
CREATE INDEX "student_badges_awarded_at_idx" ON "student_badges"("awarded_at");
