-- A track sets how many times the sheikh is heard, and the listens are counted like the other counted steps.
ALTER TABLE "track_templates" ADD COLUMN "listen_target" SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE "wird_progress" ADD COLUMN "listen_count" SMALLINT NOT NULL DEFAULT 0;

-- Listening used to be ticked, and is now counted. Whoever ticked it keeps it done.
UPDATE "wird_progress" AS wp
SET "listen_count" = 1
FROM "student_plans" AS sp
JOIN "track_templates" AS t ON t."id" = sp."template_id"
WHERE sp."id" = wp."plan_id"
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(t."wird_steps", '[{"id": 1, "kind": "LISTEN"}]'::jsonb)) AS step
    WHERE step->>'kind' = 'LISTEN' AND (step->>'id')::int = ANY(wp."done_steps")
  );
