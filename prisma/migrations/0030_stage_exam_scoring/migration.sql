-- CreateEnum
CREATE TYPE "StageExamMarkKind" AS ENUM ('HIFZ', 'PROMPT', 'HESITATION', 'TAJWEED');

-- AlterTable
ALTER TABLE "stage_exam_sessions" ADD COLUMN "scoring" JSONB;
ALTER TABLE "stage_exam_sessions" ADD COLUMN "note" VARCHAR(500);

-- CreateTable
CREATE TABLE "stage_exam_items" (
    "id" VARCHAR(32) NOT NULL,
    "session_id" VARCHAR(32) NOT NULL,
    "surah" SMALLINT NOT NULL,
    "from_ayah" SMALLINT NOT NULL,
    "to_ayah" SMALLINT NOT NULL,
    "score" DECIMAL(4,2),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_exam_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stage_exam_items_range_check" CHECK ("surah" BETWEEN 1 AND 114 AND "from_ayah" >= 1 AND "to_ayah" >= "from_ayah")
);

CREATE TABLE "stage_exam_marks" (
    "id" VARCHAR(32) NOT NULL,
    "item_id" VARCHAR(32) NOT NULL,
    "kind" "StageExamMarkKind" NOT NULL,
    "note" VARCHAR(300),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_exam_marks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stage_exam_items_session_id_created_at_idx" ON "stage_exam_items"("session_id", "created_at");
CREATE INDEX "stage_exam_marks_item_id_created_at_idx" ON "stage_exam_marks"("item_id", "created_at");

-- AddForeignKey
ALTER TABLE "stage_exam_items" ADD CONSTRAINT "stage_exam_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "stage_exam_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_exam_marks" ADD CONSTRAINT "stage_exam_marks_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stage_exam_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
