-- Attendance is now counted from one record per student per day (attendance_on).
-- Before this, a recitation kept its attendance on its own row, so a day with a recitation and an
-- attendance-sheet entry counted twice, and a day with only recitations wasn't a day record at all.
-- For each student and Riyadh day that has attendance but no day record yet, the latest recitation of
-- that day becomes the day's record. Days that already have a sheet entry keep it.
UPDATE "evaluations" AS e
SET "attendance_on" = d."day"
FROM (
  SELECT DISTINCT ON ("student_id", ("created_at" AT TIME ZONE 'Asia/Riyadh')::date)
    "id",
    ("created_at" AT TIME ZONE 'Asia/Riyadh')::date AS "day"
  FROM "evaluations"
  WHERE "attendance" IS NOT NULL AND "attendance_on" IS NULL
  ORDER BY "student_id", ("created_at" AT TIME ZONE 'Asia/Riyadh')::date, "created_at" DESC
) AS d
WHERE e."id" = d."id"
  AND NOT EXISTS (
    SELECT 1 FROM "evaluations" AS x
    WHERE x."student_id" = e."student_id" AND x."attendance_on" = d."day"
  );
