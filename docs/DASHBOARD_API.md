# واجهة لوحة التحكم

العنوان في التطوير: `http://localhost:4000/v1`. كل الطلبات والردود JSON، ما عدا رفع الملفات.

## الاتصال من اللوحة

- أرسل كل طلب من المتصفح مع `credentials: 'include'`. الجلسة في كوكيز `HttpOnly` لا يقرؤها JavaScript.
- طلبات التعديل تحتاج `Origin` من `ADMIN_ORIGINS`. المتصفح يرسله تلقائيًا. إذا جاء الطلب من خادم Next، فأرسل `Origin` وكوكيز المستخدم بنفسك.
- عند رد `401` بالكود `invalid_token`: استدعِ `POST /staff/auth/refresh` مرة واحدة ثم أعد الطلب. إذا فشل التجديد، فانتقل إلى صفحة الدخول. لا ترسل طلبي تجديد معًا، لأن إعادة استخدام التوكن تنهي الجلسة.
- التواريخ بصيغة ISO 8601. الأيام تُحسب بتوقيت الرياض.
- قيمة `null` في الأرقام تعني «لا توجد بيانات بعد»، فاعرض «—» ولا تعرض 0.
- في الإنتاج يجب أن تكون اللوحة والـ API تحت نطاق واحد، وإلا فلن تُرسل الكوكيز.

## الأخطاء

```json
{ "statusCode": 409, "code": "circle_full", "requestId": "..." }
```

اعتمد على `code` لاختيار الرسالة. أخطاء التحقق `400 validation_failed` فيها مصفوفة `errors`. طلب سجل خارج صلاحية المستخدم يعيد `404`، وليس `403`، حتى لا يكشف وجوده.

## الدخول

`POST /staff/auth/password/forgot` بالجسم `{ email }`: يرد 204 دائمًا، ويرسل رابط تعيين كلمة مرور صالحًا لساعة إذا كان الحساب موجودًا ونشطًا. الإرسال عبر `MAIL_DELIVERY` (`console` للتطوير، و`smtp` مع `SMTP_URL` و`MAIL_FROM` للإنتاج). ويبقى تطبيق المصادقة كما هو بعد الاستعادة.

`POST /staff/auth/login` بالجسم `{ identifier, password }`، و`identifier` هو البريد أو رقم الجوال. الرد يحدد الخطوة التالية:

| `next` | المعنى | الخطوة |
|---|---|---|
| `done` | دخل المستخدم | اقرأ `GET /staff/auth/me` وافتح اللوحة حسب `role` |
| `totp` | يلزم رمز المصادقة | اطلب الرمز ثم `POST /staff/auth/totp/verify` بالجسم `{ mfaToken, code }` |
| `enroll_totp` | يلزم إعداد تطبيق المصادقة أول مرة | `POST /staff/auth/totp/enroll` بالجسم `{ mfaToken }` يعيد `{ secret, otpauthUri }`، ثم `POST /staff/auth/totp/confirm` بالجسم `{ mfaToken, code }` |

- `mfaToken` صالح 5 دقائق. فشل الدخول يعيد `401 invalid_credentials` مهما كان السبب.
- TOTP إلزامي للمشرفة والمديرة، وغير مفعّل للمعلمة بقرار من صاحب المشروع.

| المسار | الوظيفة |
|---|---|
| `POST /staff/auth/refresh` | يجدد الجلسة من الكوكي |
| `POST /staff/auth/logout` | يسجل الخروج |
| `GET /staff/auth/me` | `{ id, name, email, role, scope, circles, totpEnabled }` |
| `POST /staff/auth/password/set` | `{ token, password }` من رابط الإعداد |
| `POST /staff/auth/password/change` | `{ currentPassword, newPassword }` ويخرج الأجهزة الأخرى |

كلمة المرور من 12 حرفًا على الأقل. الأكواد: `weak_password` و`leaked_password` و`invalid_setup_token` و`invalid_current_password`.

**لا يوجد «نسيت كلمة المرور» ذاتيًا بعد**، لأن قناة الإرسال لم تُحدد. البديل: المديرة تعيد التعيين وتعطي الموظفة رابطًا جديدًا.

**أول مديرة:** `npm run admin:create -- name@example.com "الاسم الكامل"` من مجلد `backend`.

## كيف تُحسب الخطة

- **تبدأ** خطة الطالبة عند تسجيلها، وتُبنى من قالب مسارها. والحلقة تضيف المعلمة والمتابعة والبوابة.
- **الوحدة** هي مقدار اليوم: نصف وجه، أو وجه، أو سورة، والمحرك يقسم السور حسب صفحات مصحف التطبيق.
- **الجدول:** أيام الورد تتقدم وحدة وحدة، وبعد كل سورة أيام التثبيت، وبقية الأسبوع مراجعة.
- **الإنجاز** يُسجل عند ضغط الطالبة «أتممت»، أو عندما تسجل المعلمة تسميعًا بحالة `MASTERED` يغطي الوحدة التالية.
- **التأخر** هو الوحدات المستحقة في الأيام المنتهية ولم تُنجز. ورد اليوم لا يُعد تأخرًا قبل انتهاء اليوم، وانتظار البوابة لا يُحتسب.
- **`commitment`** هو المنجز من المستحق، و`progress` هو المنجز من المسار كله.

حالة الطالبة `status`: `no_plan` أو `regular` أو `late` أو `awaiting_gate` أو `completed` أو `absent` (آخر 3 سجلات حضور كلها غياب).

## لكل حسابات اللوحة

| المسار | الوظيفة |
|---|---|
| `GET /staff/notifications` | `{ unread, items }`، وفي كل عنصر `opens`: `tasks` أو `approvals` أو `null` |
| `POST /staff/notifications/read-all` و`POST /staff/notifications/:id/read` | تحديدها كمقروءة |

## اختبار القبول: `/admissions` (SUPERVISOR وADMIN)

| المسار | الوظيفة |
|---|---|
| `GET /admissions` | الطالبات بانتظار الاختبار ومن لم يُقبلن، مع رقم الجوال للتواصل |
| `POST /admissions/:id/decision` | `{ accepted, score, note }`. القبول يبدأ الخطة ويصل الطالبة تنبيه |

يضبطه `PUT /admin/settings/admission` بالجسم `{ required }`. والطالبة غير المقبولة لا خطة لها ولا تظهر في التوزيع (`409 student_not_admitted`).

## المعلمة: `/teacher` (TEACHER فقط)

| المسار | الوظيفة |
|---|---|
| `GET /teacher/students/:id/record` | تبويبات الملف: `memorized` و`days` و`recitations` و`stageExams` و`attendance` و`tasks` |
| `GET /teacher/stage-exams` | `{ passScore, items }` ما سجلته المعلمة |
| `GET /teacher/announcements` | ما يصل المعلمة من الإعلانات |
| `POST /teacher/gates/:id/lesson/confirm` و`/lesson/reject` | تأكيد حضور درس التدبر أو رفضه. الاعتماد قبل التأكيد يعيد `409 lesson_not_confirmed` |
| `GET /teacher/home` | `circles` و`stats` و`today` (مع `wird` و`delay`) و`nextSession` |
| `GET /teacher/students?page&limit&search` | `{ total, items }` مع `status` و`progress` و`commitment` و`delay` و`wird` و`passedSurahs` و`nextGate` |
| `GET /teacher/students/:id` | الملف مع `attendance` و`week` و`gates` و`evaluations` و`segments` |
| `GET /teacher/surahs` | السور وعدد آياتها |
| `GET /teacher/recitations?page&limit&studentId` | سجل التسميع |
| `POST /teacher/recitations` | `{ studentId, surah, fromAyah, toAyah, score, note?, segmentStatus, attendance }` |
| `POST /teacher/attendance` | `{ studentId, attendance }` بلا تسميع، و`attendance`: `PRESENT` أو `LATE` أو `ABSENT` أو `EXCUSED`. إعادة الحفظ في اليوم نفسه تصحّح السجل |
| `GET /teacher/attendance` | كشف اليوم: `date` و`circles` ولكل حلقة `students` مع `attendance` أو `null` |
| `POST /teacher/attendance/sheet` | `{ entries: [{ studentId, attendance }] }` يُحفظ كله أو لا شيء منه |
| `GET /teacher/tasks?status` | `status`: `ongoing` أو `overdue` أو `done`، مع `completed` و`total` |
| `POST /teacher/tasks` | `{ title, description?, studentId?, circleId?, recurrence, dueAt?, deadlineMinutes? }` |
| `DELETE /teacher/tasks/:id` | أرشفة |
| `GET /teacher/sessions?kind&page&limit` | `kind`: `RECITATION` أو `CORRECTION` |
| `POST /teacher/sessions` | `{ kind, title, scheduledAt, studentId?, circleId? }` |
| `GET /teacher/sessions/:id` | جلسة واحدة |
| `POST /teacher/sessions/:id/start` و`/end` و`/cancel` | تغيير الحالة. البدء يرسل تنبيهًا للطالبة، والإنهاء يغلق الغرفة الصوتية للطرفين |
| `POST /teacher/sessions/:id/voice-ticket` | `{ ticket, iceServers }` لجلسة جارية مع طالبة واحدة. التذكرة لمرة واحدة وتنتهي بعد دقيقة. جلسة الحلقة كاملة: `group_voice_unsupported` |
| `POST /teacher/sessions/:id/evaluation` | تقييم جلسة تسميع منتهية، مرة واحدة |
| `POST /teacher/sessions/:id/notes` | `{ notes }` لجلسة تصحيح منتهية |
| `GET /teacher/gates` | البوابات بانتظار القرار، بشروطها و`readyForDecision`، مع `reflection` وهو ما كتبته الطالبة عن الدرس |
| `POST /teacher/gates/:id/approve` | `{ score }` أو `{ score: null }` إذا لم يكن الاختبار مطلوبًا |
| `POST /teacher/gates/:id/return` | `{ note }` يعيد التغليف والاختبار وتبقى البوابة مفتوحة |
| `GET /teacher/skip-requests` | طلبات التجاوز |
| `POST /teacher/skip-requests/:id/approve` و`/reject` | القرار |
| `POST /teacher/stage-exams` | `{ studentId, stage, score }` |
| `GET /teacher/reports?period=week\|month` | لكل طالبة: `attendanceRate` و`averageScore` و`recitations` و`completion` و`delay` و`nextGate` و`passedGates` |
| `GET /teacher/reports/weekly-pages` | آخر 4 أسابيع لكل مسار: `memorized` الأوجه المحفوظة، و`reviewed` الأوجه التي سمعتها المعلمة |
| `GET /teacher/transfers` | طلبات النقل الواردة |
| `POST /teacher/transfers/:id/accept` و`/reject` | قرار المعلمة |

ملاحظات:
- `attendance`: `PRESENT` أو `LATE` أو `ABSENT`. مع `ABSENT` يجب أن يكون `score` و`segmentStatus` قيمتهما `null`، وغير ذلك يجب إرسال `score`.
- `segmentStatus`: `MASTERED` أو `NEEDS_REVIEW`. `recurrence`: `DAILY` أو `ONCE`، و`dueAt` مطلوب مع `ONCE` فقط.
- حالات الجلسة `SCHEDULED` ثم `IN_PROGRESS` ثم `COMPLETED`، أو `CANCELLED`. «بانتظار التقييم» هي `COMPLETED` مع `evaluated: false`، و`student: null` تعني الحلقة كاملة.
- أكواد البوابة: `gate_conditions_unmet` و`exam_not_due` و`score_required` و`score_below_pass`.

## المشرفة: `/supervisor` (SUPERVISOR فقط، وداخل نطاقها)

| المسار | الوظيفة |
|---|---|
| `GET /supervisor/home` | `scope` و`stats` و`circles` |
| `GET /supervisor/circles` | لكل حلقة: `teacher` و`students` و`capacity` و`attendance` و`commitment` و`weeklyRecitations` |
| `POST /supervisor/circles` | `{ name, teacherId, trackId, capacity? }`. لكل حلقة مسار واحد، وللمسار عدة حلقات حسب عدد الطالبات. الكودان: `teacher_busy` و`unknown_track` |
| `PATCH /supervisor/circles/:id` | `{ name?, teacherId?, capacity? }`، و`null` في المعلمة يزيلها. عند تغيير المعلمة تُلغى جلسات السابقة القادمة. الأكواد: `teacher_busy` و`capacity_below_students` |
| `DELETE /supervisor/circles/:id` | أرشفة، والحلقة يجب أن تكون فارغة (`circle_not_empty`) |
| `POST /supervisor/circles/:id/students` | `{ studentId }`، وتكون الطالبة على مسار الحلقة ولا أثر لعمرها. الأكواد: `circle_full` و`already_assigned` و`track_mismatch` و`circle_has_no_track` |
| `DELETE /supervisor/circles/:id/students/:studentId` | تعود الطالبة إلى غير المسندات، وتبقى خطتها وسجلها، ويُلغى طلب نقلها المفتوح وجلساتها المجدولة في الحلقة |
| `PUT /supervisor/circles/order` | `{ circleIds }` بكل حلقات النطاق بالترتيب الجديد. الكود: `order_out_of_date` |
| `PUT /supervisor/circles/:id/students/order` | `{ studentIds }` بكل طالبات الحلقة بالترتيب الجديد. الكود: `order_out_of_date` |
| `GET /supervisor/teachers` | لكل معلمة: `phone` و`circles` و`available` |
| `GET /supervisor/teachers/:id` | `account` و`stats` و`nextSession` و`circles` و`students` |
| `PATCH /supervisor/teachers/:id` | `{ fullName?, phone? }`. البريد والإيقاف وإعادة ضبط الدخول للإدارة فقط. الكود: `identity_taken` |
| `GET /supervisor/teachers/:id/activity` | سجل عملها |
| `GET /supervisor/distribution` | `circles` بطالباتها، و`unassigned` كاملة بلا حد، و`transfers` المفتوحة |
| `POST /supervisor/transfers` | `{ studentId, toCircleId }`. الكود: `transfer_in_progress` |
| `POST /supervisor/transfers/:id/cancel` | إلغاء طلب مفتوح |
| `GET /supervisor/plans?circleId&teacherId&trackId` | `stats` و`behind` و`circles` بنسبة الالتزام |
| `POST /supervisor/students/:id/remind` | تنبيه واحد في اليوم، ويعيد `{ sent }` |
| `GET /supervisor/templates` | `canEdit` و`tracks` بعدد الطالبات و`circles` بمسارها |
| `PATCH /supervisor/circles/:id/track` | `{ trackId }`. الكودان: `templates_locked` و`circle_has_other_track` |
| `GET /supervisor/reports/stage?circleId&teacherId&days` | `stats` و`byCircle` و`byTrack` |
| `GET /supervisor/reports/gates?circleId&teacherId` | لكل حلقة: `passed` و`skipped` و`pending` |
| `GET /supervisor/reports/activity?days` | الحضور والتسميع والمهام والجلسات لكل حلقة ومعلمة |
| `GET /supervisor/announcements/incoming` | ما يصل المشرفة من الإدارة، مع `status` |
| `GET /supervisor/announcements` و`POST` | إعلانات النطاق: `{ audience: 'SCOPE' \| 'CIRCLE', circleId?, title, body }` |

مراحل النقل: `PENDING_ADMIN` ثم `PENDING_TEACHER` ثم `COMPLETED`، أو `REJECTED` أو `CANCELLED`. تنتقل الطالبة عند قبول المعلمة الجديدة فقط.

## الإدارة: `/admin` (ADMIN فقط)

| المسار | الوظيفة |
|---|---|
| `GET /admin/overview` | `stats` و`byCountry` و`byTrack` |
| `GET /admin/reports/program?days` | البوابات والاختبارات وتفصيل النطاقات |
| `GET /admin/audit?actorId&page&limit` | سجل التعديلات |

**الحسابات والحلقات**

| المسار | الوظيفة |
|---|---|
| `GET /admin/staff?role&page&limit` | الموظفات |
| `POST /admin/staff` | `{ fullName, email?, phone?, role, scopeId?, circleId? }` ويعيد `setupToken` يظهر مرة واحدة |
| `PATCH /admin/staff/:id` | `{ fullName?, scopeId?, status? }` |
| `POST /admin/staff/:id/reset-credentials` | يمسح كلمة المرور وTOTP، وينهي الجلسات، ويعيد `setupToken` جديدًا |
| `GET /admin/scopes` و`POST` و`PATCH /admin/scopes/:id` | النطاقات: `{ name }` |
| `GET /admin/circles` و`POST` | `{ name, scopeId, teacherId?, capacity?, trackId? }` |
| `GET /admin/students?search&country&trackId&section&status&page&limit` | الطالبات بأرقام مقنّعة. `status`: `active` أو `awaitingAssignment` أو `suspended` |
| `POST /admin/students` | `{ fullName, phone, country, trackId, section }` |
| `PATCH /admin/students/:id` | `{ status }` |
| `GET /admin/transfers?status` | طلبات النقل، والافتراضي `PENDING_ADMIN` |
| `POST /admin/transfers/:id/approve` و`/reject` | قرار الإدارة |

رابط الإعداد في اللوحة: `/set-password?token=...`، صالح 72 ساعة ولمرة واحدة.

**إدارة المشرفات والمعلمات**

المشرفة مسؤولة عن نطاقها كله، والمعلمة عن حلقتها. وصفوف `GET /admin/staff` فيها أيضًا `circles` و`students` و`teachers` و`supervisors`، ويقبل المسار فلتر `scopeId`.

| المسار | الوظيفة |
|---|---|
| `GET /admin/supervisors/:id` | `account` و`colleagues` و`stats` و`teachers` و`circles` و`transfers` المفتوحة و`announcements`. وبلا نطاق: `stats: null` والقوائم فارغة |
| `GET /admin/teachers/:id` | `account` و`supervisors` و`stats` و`nextSession` و`circles` و`students` و`transfers` المفتوحة |
| `PATCH /admin/staff/:id` | يقبل أيضًا `email` و`phone`. الكود: `identity_taken` |
| `POST /admin/teachers/:id/move` | `{ scopeId }` ينقل المعلمة إلى نطاق آخر مع حلقتها وطالباتها |
| `PATCH /admin/circles/:id` | `{ name?, capacity?, scopeId?, teacherId?, trackId? }`، و`null` في المعلمة يزيلها، أما المسار فيُستبدل ولا يُزال. عند تغيير المعلمة تُلغى جلسات السابقة القادمة. الأكواد: `teacher_busy` و`teacher_other_scope` و`capacity_below_students` و`unknown_track` و`circle_has_other_track` |
| `DELETE /admin/circles/:id` | أرشفة حلقة فارغة، وتُلغى جلساتها القادمة وطلبات النقل إليها. الكود: `circle_not_empty` |
| `POST /admin/circles/:id/students` | `{ studentId }`. الأكواد: `circle_full` و`already_assigned` |
| `DELETE /admin/circles/:id/students/:studentId` | تعود الطالبة إلى انتظار الإسناد وتبقى خطتها، وتُلغى جلساتها القادمة وطلب نقلها المفتوح |
| `POST /admin/transfers` | `{ studentId, toCircleId }` يبدأ بمرحلة `PENDING_TEACHER`. الأكواد: `circle_has_no_teacher` و`already_in_circle` و`transfer_in_progress` |
| `POST /admin/transfers/:id/cancel` | إلغاء طلب مفتوح في أي مرحلة |

**المنهج**

| المسار | الوظيفة |
|---|---|
| `GET /admin/tracks` | القوالب مع `reviewDays` و`enrollment` |
| `POST /admin/tracks` | حفظ: `{ kind: 'MEMORIZATION', name, audience, duration, dailyUnit, wirdDays, consolidationDays, wirdSteps?, repeatTarget?, reviewTarget?, encouragements? }`. `wirdSteps` قائمة مرتبة من `{ id?, kind, title, subtitle? }`، و`kind` أحد `REVIEW` و`REPEAT` (عدّادان، ولكل منهما خطوة واحدة على الأكثر) و`LISTEN` و`TASK`. تصحيح: `{ kind: 'CORRECTION', name, audience, duration, focus, sessionsPerWeek, application }` |
| `PATCH /admin/tracks/:id` | الحقول نفسها و`active`. الأكواد: `track_has_progress` و`field_not_for_this_track` |
| `GET /admin/gate-rules` | `conditions` و`tracks` بحالتها |
| `PUT /admin/gate-rules/conditions` | `{ tafsir, wrap, wrapCount, exam, passScore, examDelayDays }` |
| `PATCH /admin/gate-rules/tracks/:id` | `{ mode: 'ACTIVE' \| 'RELAXED' \| 'TEACHER' \| 'PAUSED' }` |
| `GET /admin/gate-exceptions` و`POST` و`DELETE /:id` | `{ studentId, type, reason, expiresAt? }`، و`type`: `SKIP_WRAP` أو `SKIP_TAFSIR` أو `RELAXED_GATE` أو `POSTPONE_EXAM` |
| `GET /admin/tadabbur` | 114 سورة بحالتها: `complete` أو `draft` أو `empty` |
| `GET /admin/tadabbur/:surah` و`PUT` | `{ lessonType, sheikh, schedule, link, journaling, published, tasks: [{ id?, title, note }] }`. الكود: `incomplete_content` |

**محتوى المصحف**

| المسار | الوظيفة |
|---|---|
| `GET /admin/quran-content` | `facts` و`translations` |
| `POST /admin/translations` | `multipart/form-data`: `file` (JSON أو CSV حتى 20MB) و`language` و`source` |
| `GET /admin/translations/:id/preview?surah&ayah` | معاينة آية |
| `POST /admin/translations/:id/approve` و`/reject` | القرار |

الملف صفوف فيها `surah` و`ayah` و`text`، ويغطي كل الآيات الـ 6236 مرة واحدة. الأكواد: `unsupported_file_type` و`unreadable_file` و`invalid_translation_rows` و`invalid_ayah_reference` و`markup_not_allowed` و`incomplete_translation` و`file_required`.

**الإعدادات**

| المسار | الوظيفة |
|---|---|
| `GET /admin/settings` | `features` و`permissions` و`pledges` و`pages` و`languagePacks` |
| `PUT /admin/settings/features` | `{ englishEnabled, smartRecitation, offlineRecitation, encouragementEnabled }` |
| `PUT /admin/settings/permissions` | `{ openRecord, editTemplates }` |
| `PUT /admin/settings/pledges` | `{ items }` ثلاثة بنود، ويرفع رقم الإصدار |
| `PATCH /admin/settings/pages/:slug` | `{ title, body }` |
| `POST /admin/settings/languages/:code` | `multipart/form-data`: `file` JSON حتى 2MB، و`code`: `ar` أو `en` |

**التحفيز**

| المسار | الوظيفة |
|---|---|
| `GET /admin/motivation` | `badges` و`messages` و`messagesEnabled` و`certificates` و`topCircles` |
| `PATCH /admin/badges/:id` | `{ condition }` |
| `POST /admin/students/:id/badges` | `{ badgeId }` منح يدوي |
| `POST /admin/encouragement-messages` و`DELETE /:id` | `{ text }` |
| `POST /admin/circles/:id/honor` | مرة واحدة في الشهر |

**الإعلانات والتنبيهات**

| المسار | الوظيفة |
|---|---|
| `GET /admin/broadcasts?kind&page&limit` | `kind`: `ANNOUNCEMENT` أو `ALERT`، مع `status`: `visible` أو `scheduled` أو `ended` |
| `POST /admin/broadcasts` | `{ kind, title, body, audience, startsAt?, endsAt? }`. `audience`: `{ type: 'ALL' }` أو `{ type: 'TRACK', trackId }` أو `{ type: 'CIRCLE', circleId }` |
| `POST /admin/broadcasts/:id/end` و`DELETE /:id` | إنهاء أو حذف إعلان |

التنبيه يصل فورًا ويعيد `recipients`، وليس له فترة ظهور.

## لم يُنفذ

- **رؤى الذكاء الاصطناعي** في الصفحة الرئيسية: لا يوجد مصدر لها، فاعرضها فارغة أو أخفِها بدل النصوص التجريبية.
- **تصميم الشهادة:** المتاح قائمة من أتممن مساراتهن، وليس توليد ملف الشهادة.
- **الإشعارات خارج التطبيق:** الإشعار يُحفظ ليظهر داخل التطبيق، ولا يوجد إرسال Push بعد.
