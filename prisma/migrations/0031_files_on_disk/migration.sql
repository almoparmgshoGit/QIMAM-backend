-- Files now live in the uploads folder on the server. These columns keep only files saved before the move.
ALTER TABLE "badge_images" ALTER COLUMN "data" DROP NOT NULL;
ALTER TABLE "certificate_backgrounds" ALTER COLUMN "data" DROP NOT NULL;
ALTER TABLE "recitation_audio" ALTER COLUMN "data" DROP NOT NULL;
