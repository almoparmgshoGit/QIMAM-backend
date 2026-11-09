-- CreateEnum
CREATE TYPE "DayTaskKind" AS ENUM ('REVIEW', 'WRAP', 'CONSOLIDATION');

-- CreateTable
CREATE TABLE "wird_progress" (
    "plan_id" VARCHAR(32) NOT NULL,
    "unit_index" INTEGER NOT NULL,
    "done_steps" INTEGER[],
    "repeat_count" SMALLINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wird_progress_pkey" PRIMARY KEY ("plan_id","unit_index")
);

-- CreateTable
CREATE TABLE "day_completions" (
    "student_id" VARCHAR(32) NOT NULL,
    "done_on" DATE NOT NULL,
    "kind" "DayTaskKind" NOT NULL,
    "detail" VARCHAR(60),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_completions_pkey" PRIMARY KEY ("student_id","done_on","kind")
);

-- CreateTable
CREATE TABLE "tadabbur_reflections" (
    "student_id" VARCHAR(32) NOT NULL,
    "surah" SMALLINT NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tadabbur_reflections_pkey" PRIMARY KEY ("student_id","surah")
);

-- AddForeignKey
ALTER TABLE "wird_progress" ADD CONSTRAINT "wird_progress_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "student_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_completions" ADD CONSTRAINT "day_completions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tadabbur_reflections" ADD CONSTRAINT "tadabbur_reflections_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
