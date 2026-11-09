-- What the tests assume an administrator has already added. Production starts empty.
INSERT INTO "track_templates"
  ("id", "code", "kind", "name", "audience", "duration", "active", "gate_mode", "daily_unit", "wird_days", "consolidation_days", "surah_order", "updated_at")
SELECT substr(md5(random()::text || code), 1, 32), code, 'MEMORIZATION'::"TrackKind", name, audience, duration, true, mode::"GateMode", unit::"DailyUnit",
       ARRAY[0,1,2,3,4], 1,
       (SELECT array_agg(n ORDER BY CASE WHEN n >= 18 THEN n - 18 ELSE n + 97 END) FROM generate_series(1, 114) n),
       now()
FROM (VALUES
  ('advanced', 'مسار الحفظ المتقدم', 'الراغبات في الحفظ السريع والمكثف', '3 سنوات', 'ACTIVE', 'PAGE'),
  ('steady', 'مسار الحفظ المتأني', 'المبتدئات وأصحاب الانشغالات', '5.5 سنوات تقريبًا', 'ACTIVE', 'HALF_PAGE'),
  ('stabilization', 'مسار الضبط والتثبيت', 'الخاتمات ومن تعاني تفلّت الحفظ', '4 أشهر · 120 يومًا', 'TEACHER', 'SURAH')
) AS t(code, name, audience, duration, mode, unit);

INSERT INTO "track_templates"
  ("id", "code", "kind", "name", "audience", "duration", "active", "gate_mode", "wird_days", "surah_order", "focus", "sessions_per_week", "application", "updated_at")
VALUES (substr(md5(random()::text), 1, 32), 'correction', 'CORRECTION', 'مسار تصحيح التلاوة', 'غرفة مستقلة عن مسارات الحفظ · لضبط التلاوة',
        'حسب المستوى', true, 'PAUSED', '{}', '{}', 'مخارج وتجويد', 3, 'داخل الغرفة', now());

INSERT INTO "encouragement_messages" ("id", "text") VALUES
  (substr(md5('m1'), 1, 32), 'بوركت همتك'),
  (substr(md5('m2'), 1, 32), 'إنجازك جميل'),
  (substr(md5('m3'), 1, 32), 'رفعك الله بالقرآن'),
  (substr(md5('m4'), 1, 32), 'جعل الله القرآن شفيعًا لكِ'),
  (substr(md5('m5'), 1, 32), 'سيشهد لكِ القرآن يومًا');

INSERT INTO "badges" ("id", "code", "label", "condition", "icon") VALUES
  (substr(md5('b1'), 1, 32), 'dedication', 'همة عالية', 'المواظبة على الورد 30 يومًا متتالية', 'flame-outline'),
  (substr(md5('b2'), 1, 32), 'mastery', 'متقنة', 'نسبة إتقان 90% في شهر', 'star-outline'),
  (substr(md5('b3'), 1, 32), 'surahComplete', 'خاتمة سورة', 'اجتياز بوابة أي سورة', 'book-outline'),
  (substr(md5('b4'), 1, 32), 'quranCompanion', 'صاحبة القرآن', 'إتمام المسار كاملًا', 'repeat');

INSERT INTO "info_pages" ("slug", "title", "body", "updated_at") VALUES
  ('about', 'عن برنامج قمم', 'برنامج لحفظ القرآن الكريم وتدبره في حلقات تتابعها معلمات متخصصات.', now()),
  ('methodology', 'منهجية البرنامج', 'حفظ يومي، ومراجعة أسبوعية، وبوابة تدبر بعد كل سورة.', now()),
  ('tracks', 'المسارات', 'المسار المتقدم، والمسار المتأني، ومسار الضبط والتثبيت.', now()),
  ('faq', 'الأسئلة الشائعة', 'إجابات عن أكثر الأسئلة تكرارًا حول التسجيل والمسارات والحلقات.', now());
