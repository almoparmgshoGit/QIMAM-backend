-- A resident of Saudi Arabia gives a region and a city at sign-up. Other countries give the country alone.
ALTER TABLE "users"
  ADD COLUMN "region" VARCHAR(80),
  ADD COLUMN "city" VARCHAR(80);
