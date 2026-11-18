-- Signatures, stamps and headers that certificate designs place over the page. The pictures are on disk.
CREATE TABLE "certificate_assets" (
  "id" VARCHAR(32) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "kind" VARCHAR(20) NOT NULL DEFAULT 'SIGNATURE',
  "width" SMALLINT NOT NULL,
  "height" SMALLINT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "certificate_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "certificate_assets_kind_check" CHECK ("kind" IN ('SIGNATURE', 'STAMP', 'HEADER'))
);
