-- CreateTable
CREATE TABLE "recitation_recordings" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32),
    "title" VARCHAR(200) NOT NULL,
    "surah" SMALLINT NOT NULL,
    "from_ayah" SMALLINT NOT NULL,
    "to_ayah" SMALLINT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "evaluation_id" VARCHAR(32),
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recitation_recordings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "recitation_recordings_ayahs_check" CHECK ("from_ayah" >= 1 AND "to_ayah" >= "from_ayah"),
    CONSTRAINT "recitation_recordings_duration_check" CHECK ("duration_ms" > 0)
);

-- CreateTable
CREATE TABLE "recitation_audio" (
    "recording_id" VARCHAR(32) NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "recitation_audio_pkey" PRIMARY KEY ("recording_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recitation_recordings_evaluation_id_key" ON "recitation_recordings"("evaluation_id");
CREATE INDEX "recitation_recordings_student_id_created_at_idx" ON "recitation_recordings"("student_id", "created_at");
CREATE INDEX "recitation_recordings_circle_id_evaluation_id_idx" ON "recitation_recordings"("circle_id", "evaluation_id");

-- AddForeignKey
ALTER TABLE "recitation_recordings" ADD CONSTRAINT "recitation_recordings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recitation_recordings" ADD CONSTRAINT "recitation_recordings_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recitation_recordings" ADD CONSTRAINT "recitation_recordings_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recitation_audio" ADD CONSTRAINT "recitation_audio_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recitation_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
