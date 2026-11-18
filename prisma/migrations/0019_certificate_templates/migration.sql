-- Certificates: kinds the administration designs, and the certificates students hold.
CREATE TYPE "CertificateTrigger" AS ENUM ('MANUAL', 'TRACK_COMPLETED');

CREATE TABLE "certificate_templates" (
  "id" VARCHAR(32) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "trigger" "CertificateTrigger" NOT NULL DEFAULT 'MANUAL',
  "track_template_id" VARCHAR(32),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "width" SMALLINT NOT NULL,
  "height" SMALLINT NOT NULL,
  "elements" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "certificate_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "certificate_templates_track_template_id_fkey" FOREIGN KEY ("track_template_id") REFERENCES "track_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "certificate_templates_size_check" CHECK ("width" BETWEEN 72 AND 3000 AND "height" BETWEEN 72 AND 3000)
);
CREATE INDEX "certificate_templates_trigger_active_idx" ON "certificate_templates"("trigger", "active");

CREATE TABLE "certificate_backgrounds" (
  "template_id" VARCHAR(32) NOT NULL,
  "mime_type" VARCHAR(20) NOT NULL,
  "data" BYTEA NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "certificate_backgrounds_pkey" PRIMARY KEY ("template_id"),
  CONSTRAINT "certificate_backgrounds_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "certificate_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "issued_certificates" (
  "id" VARCHAR(32) NOT NULL,
  "serial" SERIAL NOT NULL,
  "template_id" VARCHAR(32) NOT NULL,
  "student_id" VARCHAR(32) NOT NULL,
  "issued_by_id" VARCHAR(32),
  "note" VARCHAR(200),
  "issued_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "issued_certificates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issued_certificates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "certificate_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "issued_certificates_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "issued_certificates_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "issued_certificates_serial_key" ON "issued_certificates"("serial");
CREATE UNIQUE INDEX "issued_certificates_template_id_student_id_key" ON "issued_certificates"("template_id", "student_id");
CREATE INDEX "issued_certificates_student_id_idx" ON "issued_certificates"("student_id");

-- The track certificate the app drew before designs could be edited, so students who already finished keep it.
INSERT INTO "certificate_templates" ("id", "name", "trigger", "width", "height", "elements", "updated_at")
VALUES (
  'qimam_track_completion_template1',
  'شهادة إتمام مسار',
  'TRACK_COMPLETED',
  842,
  595,
  '[
    {"id":"frame","type":"rect","x":22,"y":22,"w":798,"h":551,"stroke":"#293885","strokeWidth":3,"fill":null,"radius":14},
    {"id":"inner","type":"rect","x":32,"y":32,"w":778,"h":531,"stroke":"#F48232","strokeWidth":1,"fill":null,"radius":9},
    {"id":"logo","type":"logo","x":346,"y":92,"w":150,"h":58},
    {"id":"kind","type":"text","x":80,"y":168,"w":682,"h":26,"text":"شهادة إتمام مسار","size":15,"bold":false,"color":"#B8601F","align":"center"},
    {"id":"lead","type":"text","x":80,"y":212,"w":682,"h":24,"text":"تشهد إدارة برنامج قمم بأن","size":13,"bold":false,"color":"#6C727F","align":"center"},
    {"id":"name","type":"text","x":80,"y":240,"w":682,"h":60,"text":"{{name}}","size":34,"bold":true,"color":"#293885","align":"center"},
    {"id":"track","type":"text","x":80,"y":312,"w":682,"h":32,"text":"{{أتمّ|أتمّت}} بفضل الله {{track}}","size":17,"bold":false,"color":"#141B34","align":"center"},
    {"id":"meta","type":"text","x":80,"y":372,"w":682,"h":22,"text":"{{date}} · برنامج قمم","size":12,"bold":false,"color":"#6C727F","align":"center"}
  ]'::jsonb,
  now()
);

-- Students who finished before this migration hold it from the day they finished.
INSERT INTO "issued_certificates" ("id", "template_id", "student_id", "issued_at")
SELECT substr(md5(random()::text || p."id"), 1, 32), 'qimam_track_completion_template1', p."student_id", COALESCE(p."completed_at", p."updated_at")
FROM "student_plans" p
WHERE p."status" = 'COMPLETED'
ORDER BY COALESCE(p."completed_at", p."updated_at");
