-- The administrator adds tracks, badges, messages and pages. Removes what 0004 inserted for them.
-- A track that a student's plan runs on stays: deleting it would mean deleting that plan.

DELETE FROM "encouragement_messages"
WHERE "id" IN (
  substr(md5('m1'), 1, 32), substr(md5('m2'), 1, 32), substr(md5('m3'), 1, 32),
  substr(md5('m4'), 1, 32), substr(md5('m5'), 1, 32)
);

DELETE FROM "badges"
WHERE "id" IN (substr(md5('b1'), 1, 32), substr(md5('b2'), 1, 32), substr(md5('b3'), 1, 32), substr(md5('b4'), 1, 32));

DELETE FROM "info_pages" WHERE "slug" IN ('about', 'methodology', 'tracks', 'faq');

UPDATE "users" u SET "track_id" = NULL
FROM "track_templates" t
WHERE u."track_template_id" = t."id"
  AND t."code" IN ('advanced', 'steady', 'stabilization', 'correction')
  AND NOT EXISTS (SELECT 1 FROM "student_plans" p WHERE p."template_id" = t."id");

DELETE FROM "track_templates" t
WHERE t."code" IN ('advanced', 'steady', 'stabilization', 'correction')
  AND NOT EXISTS (SELECT 1 FROM "student_plans" p WHERE p."template_id" = t."id");
