-- Administration employees and the ranks that say what each may do.
ALTER TYPE "Role" ADD VALUE 'EMPLOYEE';

CREATE TABLE "staff_ranks" (
    "id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "staff_ranks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_ranks_name_key" ON "staff_ranks"("name");

ALTER TABLE "users" ADD COLUMN "rank_id" VARCHAR(32);

CREATE INDEX "users_rank_id_idx" ON "users"("rank_id");

ALTER TABLE "users" ADD CONSTRAINT "users_rank_id_fkey" FOREIGN KEY ("rank_id") REFERENCES "staff_ranks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every employee has a rank, and no one else does. Compared as text: the new enum value
-- cannot be used as a literal in the transaction that adds it.
ALTER TABLE "users" ADD CONSTRAINT "users_rank_only_for_employees"
  CHECK (("role"::text = 'EMPLOYEE') = ("rank_id" IS NOT NULL));
