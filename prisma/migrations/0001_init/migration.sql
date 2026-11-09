
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'TEACHER', 'SUPERVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TrackId" AS ENUM ('ADVANCED', 'STEADY', 'STABILIZATION');

-- CreateEnum
CREATE TYPE "StabilizationStart" AS ENUM ('KAHF', 'FATIHA');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('AR', 'EN');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('TERMS_AND_PRIVACY', 'PLAN_PLEDGE', 'SERIOUSNESS_PLEDGE');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'REGISTER');

-- CreateEnum
CREATE TYPE "TokenAudience" AS ENUM ('MOBILE', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DAILY_WIRD', 'WEEKLY_REVIEW', 'NEW_TASK', 'EVALUATION', 'BADGES', 'GENERAL', 'ENCOURAGEMENT');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "TaskRecurrence" AS ENUM ('ONCE', 'DAILY');

-- CreateEnum
CREATE TYPE "LiveSessionStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "AnnouncementScope" AS ENUM ('ALL', 'CIRCLE');

-- CreateTable
CREATE TABLE "users" (
    "id" VARCHAR(32) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "full_name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(254),
    "country" VARCHAR(80),
    "age_band" VARCHAR(3),
    "track_id" "TrackId",
    "track_start" "StabilizationStart",
    "language" "Language" NOT NULL DEFAULT 'AR',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_credentials" (
    "user_id" VARCHAR(32) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret_encrypted" TEXT,
    "totp_enabled_at" TIMESTAMPTZ,
    "password_changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,

    CONSTRAINT "staff_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "staff_security_tokens" (
    "id" VARCHAR(32) NOT NULL,
    "user_id" VARCHAR(32) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" VARCHAR(30) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_security_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consents" (
    "id" VARCHAR(32) NOT NULL,
    "user_id" VARCHAR(32) NOT NULL,
    "type" "ConsentType" NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" VARCHAR(32) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hmac" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" VARCHAR(32) NOT NULL,
    "user_id" VARCHAR(32) NOT NULL,
    "family_id" VARCHAR(32) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "audience" "TokenAudience" NOT NULL,
    "replaced_by_id" VARCHAR(32),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" VARCHAR(32) NOT NULL,
    "type" "NotificationType" NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","type")
);

-- CreateTable
CREATE TABLE "push_devices" (
    "id" VARCHAR(32) NOT NULL,
    "user_id" VARCHAR(32) NOT NULL,
    "push_token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circles" (
    "id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "teacher_id" VARCHAR(32) NOT NULL,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "circles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_circles" (
    "supervisor_id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32) NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisor_circles_pkey" PRIMARY KEY ("supervisor_id","circle_id")
);

-- CreateTable
CREATE TABLE "circle_memberships" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32) NOT NULL,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,

    CONSTRAINT "circle_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32) NOT NULL,
    "created_by_id" VARCHAR(32),
    "title" VARCHAR(200) NOT NULL,
    "recurrence" "TaskRecurrence" NOT NULL,
    "deadline_minutes" SMALLINT,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_completions" (
    "task_id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "due_on" DATE NOT NULL,
    "completed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_completions_pkey" PRIMARY KEY ("task_id","student_id","due_on")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "teacher_id" VARCHAR(32),
    "live_session_id" VARCHAR(32),
    "title" VARCHAR(200) NOT NULL,
    "score" DECIMAL(4,1) NOT NULL,
    "max_score" DECIMAL(4,1) NOT NULL DEFAULT 10,
    "comment" VARCHAR(1000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_sessions" (
    "id" VARCHAR(32) NOT NULL,
    "circle_id" VARCHAR(32),
    "teacher_id" VARCHAR(32),
    "student_id" VARCHAR(32),
    "title" VARCHAR(120) NOT NULL,
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "status" "LiveSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "attendance" "AttendanceStatus",
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "absence_warnings" (
    "id" VARCHAR(32) NOT NULL,
    "student_id" VARCHAR(32) NOT NULL,
    "issued_by_id" VARCHAR(32),
    "level" SMALLINT NOT NULL,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "absence_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" VARCHAR(32) NOT NULL,
    "scope" "AnnouncementScope" NOT NULL,
    "circle_id" VARCHAR(32),
    "author_id" VARCHAR(32),
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" VARCHAR(32) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "condition" VARCHAR(200),
    "icon" VARCHAR(40) NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_badges" (
    "student_id" VARCHAR(32) NOT NULL,
    "badge_id" VARCHAR(32) NOT NULL,
    "awarded_by_id" VARCHAR(32),
    "awarded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_badges_pkey" PRIMARY KEY ("student_id","badge_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(32),
    "actor_role" "Role",
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(40),
    "target_id" VARCHAR(32),
    "metadata" JSONB,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "staff_security_tokens_token_hash_key" ON "staff_security_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "staff_security_tokens_user_id_purpose_idx" ON "staff_security_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "staff_security_tokens_expires_at_idx" ON "staff_security_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_consents_user_id_type_version_key" ON "user_consents"("user_id", "type", "version");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_created_at_idx" ON "otp_challenges"("phone", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_push_token_key" ON "push_devices"("push_token");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "circles_teacher_id_idx" ON "circles"("teacher_id");

-- CreateIndex
CREATE INDEX "supervisor_circles_circle_id_idx" ON "supervisor_circles"("circle_id");

-- CreateIndex
CREATE INDEX "circle_memberships_circle_id_left_at_idx" ON "circle_memberships"("circle_id", "left_at");

-- CreateIndex
CREATE INDEX "circle_memberships_student_id_idx" ON "circle_memberships"("student_id");

-- CreateIndex
CREATE INDEX "tasks_circle_id_archived_at_idx" ON "tasks"("circle_id", "archived_at");

-- CreateIndex
CREATE INDEX "task_completions_student_id_due_on_idx" ON "task_completions"("student_id", "due_on");

-- CreateIndex
CREATE INDEX "evaluations_student_id_created_at_idx" ON "evaluations"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "evaluations_teacher_id_idx" ON "evaluations"("teacher_id");

-- CreateIndex
CREATE INDEX "live_sessions_student_id_scheduled_at_idx" ON "live_sessions"("student_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "live_sessions_teacher_id_scheduled_at_idx" ON "live_sessions"("teacher_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "live_sessions_status_scheduled_at_idx" ON "live_sessions"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "absence_warnings_student_id_resolved_at_idx" ON "absence_warnings"("student_id", "resolved_at");

-- CreateIndex
CREATE INDEX "announcements_scope_published_at_idx" ON "announcements"("scope", "published_at");

-- CreateIndex
CREATE INDEX "announcements_circle_id_published_at_idx" ON "announcements"("circle_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "badges_code_key" ON "badges"("code");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_security_tokens" ADD CONSTRAINT "staff_security_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circles" ADD CONSTRAINT "circles_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_circles" ADD CONSTRAINT "supervisor_circles_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_circles" ADD CONSTRAINT "supervisor_circles_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_memberships" ADD CONSTRAINT "circle_memberships_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_memberships" ADD CONSTRAINT "circle_memberships_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absence_warnings" ADD CONSTRAINT "absence_warnings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absence_warnings" ADD CONSTRAINT "absence_warnings_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_badges" ADD CONSTRAINT "student_badges_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_badges" ADD CONSTRAINT "student_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_badges" ADD CONSTRAINT "student_badges_awarded_by_id_fkey" FOREIGN KEY ("awarded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules Prisma cannot express
ALTER TABLE "users" ADD CONSTRAINT "users_login_identifier_check"
  CHECK ((role = 'STUDENT' AND phone IS NOT NULL) OR (role <> 'STUDENT' AND email IS NOT NULL));

CREATE UNIQUE INDEX "circle_memberships_one_active_key"
  ON "circle_memberships" ("student_id") WHERE "left_at" IS NULL;

ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_score_check"
  CHECK ("max_score" > 0 AND "score" >= 0 AND "score" <= "max_score");

ALTER TABLE "absence_warnings" ADD CONSTRAINT "absence_warnings_level_check"
  CHECK ("level" BETWEEN 1 AND 3);

-- A trigger also binds the database owner, which a revoked privilege would not.
CREATE FUNCTION "reject_audit_log_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "reject_audit_log_change"();
