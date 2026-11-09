-- CreateEnum
CREATE TYPE "StudentSection" AS ENUM ('WOMEN', 'MEN');

-- CreateEnum
CREATE TYPE "TrackKind" AS ENUM ('MEMORIZATION', 'CORRECTION');

-- CreateEnum
CREATE TYPE "DailyUnit" AS ENUM ('HALF_PAGE', 'PAGE', 'SURAH');

-- CreateEnum
CREATE TYPE "GateMode" AS ENUM ('ACTIVE', 'RELAXED', 'TEACHER', 'PAUSED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "GateStatus" AS ENUM ('PENDING', 'PASSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WirdSource" AS ENUM ('STUDENT', 'TEACHER', 'SKIP');

-- CreateEnum
CREATE TYPE "SkipStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GateExceptionType" AS ENUM ('SKIP_WRAP', 'SKIP_TAFSIR', 'RELAXED_GATE', 'POSTPONE_EXAM');

-- CreateEnum
CREATE TYPE "TranslationStatus" AS ENUM ('REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('ANNOUNCEMENT', 'ALERT');

-- AlterEnum
ALTER TYPE "AnnouncementScope" ADD VALUE 'TRACK';

-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "ends_at" TIMESTAMPTZ,
ADD COLUMN     "kind" "AnnouncementKind" NOT NULL DEFAULT 'ANNOUNCEMENT',
ADD COLUMN     "recipients" INTEGER,
ADD COLUMN     "starts_at" TIMESTAMPTZ,
ADD COLUMN     "track_template_id" VARCHAR(32);

-- AlterTable
ALTER TABLE "circles" ADD COLUMN     "honored_month" VARCHAR(7),
ADD COLUMN     "track_template_id" VARCHAR(32),
ALTER COLUMN "teacher_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "section" "StudentSection" NOT NULL DEFAULT 'WOMEN',
ADD COLUMN     "track_template_id" VARCHAR(32);

-- CreateTable
CREATE TABLE "track_templates" (
    "id" VARCHAR(32) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "kind" "TrackKind" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "audience" VARCHAR(200) NOT NULL,
    "duration" VARCHAR(60) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "gate_mode" "GateMode" NOT NULL DEFAULT 'ACTIVE',
    "daily_unit" "DailyUnit",
    "wird_days" INTEGER[],
    "consolidation_days" SMALLINT NOT NULL DEFAULT 1,
    "surah_order" INTEGER[],
    "focus" VARCHAR(120),
    "sessions_per_week" SMALLINT,
    "application" VARCHAR(120),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "track_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_plans" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "template_id" VARCHAR(32) NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "start_on" DATE NOT NULL,
    "surah_order" INTEGER[],
    "completed_units" INTEGER NOT NULL DEFAULT 0,
    "credited_days" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "student_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wird_logs" (
    "plan_id" VARCHAR(32) NOT NULL,
    "unit_index" INTEGER NOT NULL,
    "source" "WirdSource" NOT NULL,
    "done_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wird_logs_pkey" PRIMARY KEY ("plan_id","unit_index")
);

-- CreateTable
CREATE TABLE "surah_gates" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "surah" SMALLINT NOT NULL,
    "status" "GateStatus" NOT NULL DEFAULT 'PENDING',
    "opened_on" DATE NOT NULL,
    "test_due_on" DATE NOT NULL,
    "tafsir_done_at" TIMESTAMPTZ,
    "wrap_count" SMALLINT NOT NULL DEFAULT 0,
    "score" DECIMAL(4,1),
    "return_note" VARCHAR(500),
    "decided_by_id" VARCHAR(32),
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surah_gates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skip_requests" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "surah" SMALLINT,
    "request" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "SkipStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" VARCHAR(32),
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skip_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_exceptions" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "type" "GateExceptionType" NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "created_by_id" VARCHAR(32),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_exams" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "teacher_id" VARCHAR(32),
    "circle_id" VARCHAR(32),
    "stage" SMALLINT NOT NULL,
    "score" DECIMAL(4,1) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surah_tadabbur" (
    "surah" SMALLINT NOT NULL,
    "lesson_type" VARCHAR(40) NOT NULL,
    "sheikh" VARCHAR(120) NOT NULL,
    "schedule" VARCHAR(80) NOT NULL,
    "link" VARCHAR(500),
    "journaling" BOOLEAN NOT NULL DEFAULT true,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "surah_tadabbur_pkey" PRIMARY KEY ("surah")
);

-- CreateTable
CREATE TABLE "tadabbur_tasks" (
    "id" VARCHAR(32) NOT NULL,
    "surah" SMALLINT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "note" VARCHAR(300) NOT NULL,
    "position" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "tadabbur_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practical_completions" (
    "task_id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practical_completions_pkey" PRIMARY KEY ("task_id","student_id")
);

-- CreateTable
CREATE TABLE "translations" (
    "id" VARCHAR(32) NOT NULL,
    "language" VARCHAR(40) NOT NULL,
    "source" VARCHAR(160) NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "status" "TranslationStatus" NOT NULL DEFAULT 'REVIEW',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_verses" (
    "translation_id" VARCHAR(32) NOT NULL,
    "surah" SMALLINT NOT NULL,
    "ayah" SMALLINT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "translation_verses_pkey" PRIMARY KEY ("translation_id","surah","ayah")
);

-- CreateTable
CREATE TABLE "language_packs" (
    "code" VARCHAR(5) NOT NULL,
    "content" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "language_packs_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(40) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "info_pages" (
    "slug" VARCHAR(40) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(20000) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "info_pages_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "encouragement_messages" (
    "id" VARCHAR(32) NOT NULL,
    "text" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encouragement_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" VARCHAR(32) NOT NULL,
    "user_id" VARCHAR(32) NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "dedupe_key" VARCHAR(80),
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "track_templates_code_key" ON "track_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "student_plans_student_id_key" ON "student_plans"("student_id");

-- CreateIndex
CREATE INDEX "student_plans_template_id_idx" ON "student_plans"("template_id");

-- CreateIndex
CREATE INDEX "wird_logs_plan_id_done_on_idx" ON "wird_logs"("plan_id", "done_on");

-- CreateIndex
CREATE INDEX "surah_gates_status_idx" ON "surah_gates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "surah_gates_student_id_surah_key" ON "surah_gates"("student_id", "surah");

-- CreateIndex
CREATE INDEX "skip_requests_student_id_status_idx" ON "skip_requests"("student_id", "status");

-- CreateIndex
CREATE INDEX "gate_exceptions_student_id_idx" ON "gate_exceptions"("student_id");

-- CreateIndex
CREATE INDEX "stage_exams_circle_id_stage_idx" ON "stage_exams"("circle_id", "stage");

-- CreateIndex
CREATE INDEX "stage_exams_student_id_stage_idx" ON "stage_exams"("student_id", "stage");

-- CreateIndex
CREATE INDEX "tadabbur_tasks_surah_position_idx" ON "tadabbur_tasks"("surah", "position");

-- CreateIndex
CREATE INDEX "practical_completions_student_id_idx" ON "practical_completions"("student_id");

-- CreateIndex
CREATE INDEX "translations_language_status_idx" ON "translations"("language", "status");

-- CreateIndex
CREATE UNIQUE INDEX "encouragement_messages_text_key" ON "encouragement_messages"("text");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_track_template_id_fkey" FOREIGN KEY ("track_template_id") REFERENCES "track_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circles" ADD CONSTRAINT "circles_track_template_id_fkey" FOREIGN KEY ("track_template_id") REFERENCES "track_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_track_template_id_fkey" FOREIGN KEY ("track_template_id") REFERENCES "track_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_plans" ADD CONSTRAINT "student_plans_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_plans" ADD CONSTRAINT "student_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "track_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wird_logs" ADD CONSTRAINT "wird_logs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "student_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surah_gates" ADD CONSTRAINT "surah_gates_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surah_gates" ADD CONSTRAINT "surah_gates_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skip_requests" ADD CONSTRAINT "skip_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skip_requests" ADD CONSTRAINT "skip_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_exceptions" ADD CONSTRAINT "gate_exceptions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_exceptions" ADD CONSTRAINT "gate_exceptions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_exams" ADD CONSTRAINT "stage_exams_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_exams" ADD CONSTRAINT "stage_exams_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_exams" ADD CONSTRAINT "stage_exams_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tadabbur_tasks" ADD CONSTRAINT "tadabbur_tasks_surah_fkey" FOREIGN KEY ("surah") REFERENCES "surah_tadabbur"("surah") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practical_completions" ADD CONSTRAINT "practical_completions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tadabbur_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practical_completions" ADD CONSTRAINT "practical_completions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_verses" ADD CONSTRAINT "translation_verses_translation_id_fkey" FOREIGN KEY ("translation_id") REFERENCES "translations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Staff may sign in with an email or a phone number.
ALTER TABLE "users" DROP CONSTRAINT "users_login_identifier_check";
ALTER TABLE "users" ADD CONSTRAINT "users_login_identifier_check"
  CHECK ((role = 'STUDENT' AND phone IS NOT NULL) OR (role <> 'STUDENT' AND (email IS NOT NULL OR phone IS NOT NULL)));

ALTER TABLE "stage_exams" ADD CONSTRAINT "stage_exams_score_check" CHECK ("score" BETWEEN 0 AND 10);
ALTER TABLE "surah_gates" ADD CONSTRAINT "surah_gates_score_check" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 10);

-- A student has one open skip request per surah.
CREATE UNIQUE INDEX "skip_requests_one_open_key"
  ON "skip_requests" ("student_id", "surah") WHERE "status" = 'PENDING' AND "surah" IS NOT NULL;

-- The original tracks. The wording, days and order come from what the app already tells students.
-- Kahf to An-Nas, then Al-Fatiha to Al-Isra.
INSERT INTO "track_templates"
  ("id", "code", "kind", "name", "audience", "duration", "active", "gate_mode", "daily_unit", "wird_days", "consolidation_days", "surah_order", "updated_at")
SELECT substr(md5(random()::text || code), 1, 32), code, 'MEMORIZATION'::"TrackKind", name, audience, duration, true, mode::"GateMode", unit::"DailyUnit",
       ARRAY[0,1,2,3,4], 1,
       (SELECT array_agg(n ORDER BY CASE WHEN n >= 18 THEN n - 18 ELSE n + 97 END) FROM generate_series(1, 114) n),
       now()
FROM (VALUES
  ('advanced', 'مسار الحفظ المتقدم', 'الراغبات في الحفظ السريع والمكثف', '3 سنوات', 'ACTIVE', 'PAGE'),
  ('steady', 'مسار الحفظ المتأني', 'المبتدئات وأصحاب الانشغالات', '5.5 سنوات تقريبًا', 'ACTIVE', 'HALF_PAGE'),
  ('stabilization', 'مسار الضبط والتثبيت', 'الخاتمات ومن تعاني تفلّت الحفظ', '4 أشهر · 120 يومًا', 'TEACHER', 'SURAH')
) AS t(code, name, audience, duration, mode, unit);

INSERT INTO "track_templates"
  ("id", "code", "kind", "name", "audience", "duration", "active", "gate_mode", "wird_days", "surah_order", "focus", "sessions_per_week", "application", "updated_at")
VALUES (substr(md5(random()::text), 1, 32), 'correction', 'CORRECTION', 'مسار تصحيح التلاوة', 'غرفة مستقلة عن مسارات الحفظ · لضبط التلاوة',
        'حسب المستوى', true, 'PAUSED', '{}', '{}', 'مخارج وتجويد', 3, 'داخل الغرفة', now());

-- Existing students join the template of the track they already chose.
UPDATE "users" u SET "track_template_id" = t."id"
FROM "track_templates" t WHERE u."track_id" IS NOT NULL AND t."code" = lower(u."track_id"::text);

INSERT INTO "encouragement_messages" ("id", "text") VALUES
  (substr(md5('m1'), 1, 32), 'بوركت همتك'),
  (substr(md5('m2'), 1, 32), 'إنجازك جميل'),
  (substr(md5('m3'), 1, 32), 'رفعك الله بالقرآن'),
  (substr(md5('m4'), 1, 32), 'جعل الله القرآن شفيعًا لكِ'),
  (substr(md5('m5'), 1, 32), 'سيشهد لكِ القرآن يومًا');

INSERT INTO "badges" ("id", "code", "label", "condition", "icon") VALUES
  (substr(md5('b1'), 1, 32), 'dedication', 'همة عالية', 'المواظبة على الورد 30 يومًا متتالية', 'flame-outline'),
  (substr(md5('b2'), 1, 32), 'mastery', 'متقنة', 'نسبة إتقان 90% في شهر', 'star-outline'),
  (substr(md5('b3'), 1, 32), 'surahComplete', 'خاتمة سورة', 'اجتياز بوابة أي سورة', 'book-outline'),
  (substr(md5('b4'), 1, 32), 'quranCompanion', 'صاحبة القرآن', 'إتمام المسار كاملًا', 'repeat');

INSERT INTO "info_pages" ("slug", "title", "body", "updated_at") VALUES
  ('about', 'عن برنامج قمم', 'برنامج لحفظ القرآن الكريم وتدبره في حلقات تتابعها معلمات متخصصات.', now()),
  ('methodology', 'منهجية البرنامج', 'حفظ يومي، ومراجعة أسبوعية، وبوابة تدبر بعد كل سورة.', now()),
  ('tracks', 'المسارات', 'المسار المتقدم، والمسار المتأني، ومسار الضبط والتثبيت.', now()),
  ('faq', 'الأسئلة الشائعة', 'إجابات عن أكثر الأسئلة تكرارًا حول التسجيل والمسارات والحلقات.', now());
