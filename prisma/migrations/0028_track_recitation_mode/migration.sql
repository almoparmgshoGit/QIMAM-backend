-- CreateEnum
CREATE TYPE "RecitationMode" AS ENUM ('LIVE', 'RECORDING', 'NONE');

-- AlterTable: existing tracks keep reciting in voice sessions, as before.
ALTER TABLE "track_templates" ADD COLUMN "recitation_mode" "RecitationMode" NOT NULL DEFAULT 'LIVE';
