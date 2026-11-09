-- A session gets one evaluation, even if two requests arrive at the same moment.
CREATE UNIQUE INDEX "evaluations_one_per_session_key" ON "evaluations" ("live_session_id") WHERE "live_session_id" IS NOT NULL;
