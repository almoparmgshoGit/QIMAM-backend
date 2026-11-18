-- Circle honoring certificates: one design for the circle's students and one for its teacher, given again each month a circle is honored.
ALTER TYPE "CertificateTrigger" ADD VALUE 'CIRCLE_HONOR';
ALTER TYPE "CertificateTrigger" ADD VALUE 'CIRCLE_HONOR_TEACHER';

ALTER TABLE "issued_certificates"
  ADD COLUMN "circle_id" VARCHAR(32),
  ADD COLUMN "occasion" VARCHAR(60) NOT NULL DEFAULT '';
ALTER TABLE "issued_certificates"
  ADD CONSTRAINT "issued_certificates_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "issued_certificates_template_id_student_id_key";
CREATE UNIQUE INDEX "issued_certificates_template_id_student_id_occasion_key" ON "issued_certificates"("template_id", "student_id", "occasion");
CREATE INDEX "issued_certificates_circle_id_idx" ON "issued_certificates"("circle_id");
