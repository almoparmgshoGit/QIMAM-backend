# خطة أمان باك اند قمم

**الحالة: خطة قيد التنفيذ.** وجود بند في الجداول لا يعني أنه منفّذ. قسم «ما نُفّذ» هو المرجع لما تعمل حمايته فعلًا ويغطيه اختبار.

لا يضمن هذا الجدول خلو النظام من الثغرات، لذلك نحتاج أيضًا إلى اختبار اختراق مستقل قبل الإطلاق.

## ما نُفّذ (مصادقة تطبيق الطالبات)

الاختبارات في `test/auth.e2e-spec.ts` و`test/rate-limit.e2e-spec.ts`، وتشغيلها: `npm run test:e2e`.

- **المعرفات:** 32 حرفًا عشوائيًا من مولد آمن تشفيريًا (`nanoid`)، بدل UUIDv7 المرتب زمنيًا. صعوبة التخمين طبقة إضافية فقط، ولا تغني عن فحص الملكية.
- **الرمز (OTP):** رمز من 6 أرقام يُخزن HMAC فقط، و5 محاولات، و5 دقائق، ولمرة واحدة، وأحدث رمز فقط صالح، وفترة 60 ثانية بين الإرسالات، و5 رموز في الساعة لكل رقم، و20 طلبًا في الساعة لكل IP. والطلب والخطأ متطابقان سواء وُجد الحساب أم لا، ولا تُعرف حالة الرقم إلا بعد إثبات الرمز الصحيح.
- **JWT:** ES256 ثابت مع فرض `iss` و`aud` و`sub` و`typ` و`iat` و`nbf` و`exp` و`kid`، ورفض `jwk` و`jku` و`x5u` و`x5c` و`crit`. واختُبر رفض `none` وHS256 بالمفتاح العام والتوقيع بمفتاح آخر والحمولة المعدلة.
- **رمز التسجيل:** الرقم غير المسجل يحصل بعد التحقق على JWT مستقل (`aud` و`typ` خاصان به) صالح 30 دقيقة، ولا يقبله أي مسار آخر. والخادم يأخذ الرقم من هذا الرمز فقط، ويرفض أي `phone` مرسل بجانبه.
- **Refresh token:** قيمة عشوائية 256 بت تُخزن hash فقط، وتتغير مع كل استخدام، وإعادة استخدامها تلغي العائلة وتُسجل في التدقيق، بما فيها الطلبات المتزامنة.
- **الوصول:** Guard مغلق افتراضيًا، وحالة الحساب تُقرأ في كل طلب. ومسارات `/me` بلا معرف، فلا يمكن طلب سجل شخص آخر.
- **المدخلات والمخرجات:** رفض أي حقل غير معرّف، وحد 100KB، وJSON فقط، ومخرجات بقائمة حقول صريحة.
- **الخادم:** Helmet، و`no-store`، وأخطاء بلا stack، ورفض الإقلاع عند نقص الإعدادات أو عند استخدام طريقة تسليم الرمز عبر الكونصول في الإنتاج.
- **حذف الحساب:** حذف نهائي مع كل التوكنات والرموز، ويبقى سطر تدقيق بالمعرف فقط. وجدول التدقيق يرفض التعديل والحذف.
- **التطبيق:** refresh token في SecureStore، وaccess token في الذاكرة فقط، وطلب تجديد واحد مهما تزامنت الطلبات.

## ما نُفّذ (لوحة التحكم)

الاختبارات في `test/dashboard.e2e-spec.ts`.

- **الجلسة:** كوكيز `HttpOnly` و`SameSite=Strict`، و`Secure` في الإنتاج. والتوكن لا يظهر في جسم الرد، وrefresh لا يُرسل إلا لمسارات المصادقة، وصلاحيته 12 ساعة لا يمددها الاستخدام.
- **CSRF وCORS:** طلبات التعديل تُرفض إذا لم يكن `Origin` في قائمة `ADMIN_ORIGINS`، بما فيها الطلب بلا `Origin`، وهذا يحل محل رمز CSRF المذكور في الجدول أدناه. وCORS بقائمة محددة بلا `*`.
- **كلمات المرور:** Argon2id، و12 حرفًا على الأقل، ورفض ما يحتوي الاسم أو البريد، ورفض المسرّبة عبر Have I Been Pwned بإرسال أول 5 أحرف من الـ hash فقط. وإذا تعطلت تلك الخدمة يُقبل الطلب ويُسجل تحذير. واستدعاء الخدمة الفعلي لم يُختبر، لأن الاختبارات تستبدله.
- **الدخول:** رد موحد للبريد الخاطئ وكلمة المرور الخاطئة والحساب الموقوف أو المقفل. قفل بعد 5 محاولات، ومدته تتضاعف من 15 دقيقة إلى يوم، مع 20 محاولة لكل IP كل 15 دقيقة.
- **TOTP:** إلزامي للمشرفة والمديرة، والسر مشفر بـ AES-256-GCM. ولا يُقبل الرمز مرتين، ولا يمكن استبدال المصادقة بكلمة المرور وحدها.
- **الروابط:** رابط إعداد كلمة المرور عشوائي 256 بت، يُخزن hash فقط، لمرة واحدة، وصالح 72 ساعة، والرابط الجديد يلغي القديم.
- **الصلاحيات:** الدور والنطاق يُقرآن من القاعدة في كل طلب. والمعلمة تصل إلى طالبات حلقاتها الحالية فقط، والمشرفة إلى نطاقها فقط، وما عداه يعيد 404. وعند النقل تفقد المعلمة السابقة الوصول فورًا.
- **التزامن:** آخر مقعد في الحلقة، وحلقة واحدة لكل طالبة، ونقل مفتوح واحد، وتقييم واحد لكل جلسة، كلها محمية بقيود في القاعدة أو أقفال، واختُبرت بطلبات متزامنة.
- **التدقيق:** عمليات الموظفات تُسجل بالمعرفات والأرقام فقط، بلا أسماء أو جوالات أو ملاحظات، والأسماء تُجلب عند العرض.

## ما زال مطلوبًا قبل الإطلاق

- **قناة تسليم الرمز:** لم تُحدد بعد، والرمز يُطبع في كونصول الخادم للتطوير. ولا يقلع الخادم في الإنتاج قبل تنفيذ قناة حقيقية.
- **سقف يومي للإرسال:** يُحدد حسب القناة المختارة، للحد من احتيال تكلفة الرسائل إن كانت مدفوعة، خصوصًا أن الرمز يُرسل لأي رقم صحيح سواء كان مسجلًا أم لا. غير منفّذ.
- **تخزين مشترك لحدود IP:** العدادات الحالية في ذاكرة الخادم، وتكفي نسخة واحدة فقط. أما حدود رقم الجوال ففي القاعدة ومشتركة.
- **إعادة التحقق قبل حذف الحساب:** الحذف يتطلب جلسة صالحة وتأكيدًا في الشاشة، ولا يطلب OTP جديدًا.
- **فقدان رد التجديد:** إذا ضاع رد `/auth/refresh` بسبب انقطاع الشبكة، تُعد المحاولة التالية إعادة استخدام ويُطلب تسجيل الدخول من جديد. هذا مقبول أمنيًا لكنه قد يزعج المستخدمة، ونراقبه بعد الإطلاق.
- **HTTPS:** عنوان الخادم الحالي للتطوير المحلي فقط، والإنتاج يجب أن يكون عبر TLS.
- **النطاق في الإنتاج:** يجب أن تكون اللوحة والـ API تحت نطاق واحد، مثل `admin.example.com` و`api.example.com`، وإلا فلن يرسل المتصفح كوكيز `SameSite=Strict`.
- **قبول التعهد للطالبة المضافة من الإدارة:** الطالبة التي تضيفها المديرة لا يوجد لها سجل موافقة بعد، ويلزم أن يطلب التطبيق الموافقة عند أول دخول.
- **TOTP للمعلمات:** غير مفعّل بقرار من صاحب المشروع. تدخل المعلمة بكلمة المرور فقط، مع أنها تصل إلى بيانات طالبات.
- **رموز استرداد TOTP:** غير منفذة. من تفقد جهازها تطلب إعادة التعيين من المديرة، والمديرة الوحيدة تحتاج `npm run admin:create` من الخادم.
- **استعادة كلمة المرور ذاتيًا:** تنتظر تحديد قناة الإرسال.
- **وصول المشرفة إلى الطالبات غير المسندات:** أي مشرفة ترى اسم ومسار كل طالبة بلا حلقة، في كل النطاقات، لأن الطالبة لا تتبع نطاقًا قبل الإسناد. وهذا لا يطابق نص التعهد «لا تُشارك إلا مع معلمتك»، فيجب تعديل النص أو ربط الطالبة بنطاق عند التسجيل.

## القواعد العامة

1. كل endpoint مغلق افتراضيًا، ويحتاج فتحه إلى `@Public()` صريح.
2. الصلاحية تُفحص على الدور **وعلى ملكية السجل** في كل طلب.
3. أي حقل غير معرّف في المدخلات يُرفض، والمخرجات تمر عبر DTO صريح.
4. لا تُخزَّن الرموز والأسرار إلا مشفرة أو على شكل hash، ولا تظهر في السجلات أو الروابط.
5. لا تدخل تقنية موسومة هنا «غير مستخدمة» إلى المشروع قبل مراجعة أقسامها في هذا الملف.

الأدوار: `STUDENT` و`TEACHER` و`SUPERVISOR` و`ADMIN`. الطالبة ترى بياناتها فقط، والمعلمة ترى حلقاتها، والمشرفة ترى الحلقات المسندة إليها، والمديرة ترى الكل.

## 1. الحقن

| الثغرات | الحماية | الاختبار |
|---|---|---|
| SQLi | Prisma باستعلامات ذات معاملات، ومنع `$queryRawUnsafe` عبر lint | محاولات حقن في كل معامل بحث وترتيب |
| Command Injection, RCE | لا يوجد `exec` أو `eval` على مدخلات المستخدم، وقاعدة lint تمنعهما | فحص ثابت في CI |
| Log Injection, CRLF, HHI, HTTP Response Splitting | سجلات JSON منظمة، وعدم وضع مدخلات المستخدم في الترويسات، ورفض أسطر جديدة في النصوص القصيرة | إرسال `\r\n` في الحقول والترويسات |
| Improper Input Validation, JSON Injection, Parameter Pollution, HPP | تحقق صارم للنوع والطول والصيغة، ورفض المعاملات المكررة | اختبار لكل DTO |
| XSS, HTMLi, Stored/Reflected/DOM XSS, Improper Output Encoding, Client-Side Template Injection | التعامل مع المدخلات كنص، وتجنب `dangerouslySetInnerHTML` في اللوحة، وCSP صارم | إدخال payloads وعرضها في اللوحة |
| Host Header Injection | قائمة نطاقات مسموحة، وعدم بناء الروابط من ترويسة `Host` | طلب بترويسة `Host` مزيفة |

**غير مستخدمة:** NoSQLi لأن القاعدة PostgreSQL، وXXE وXML Injection وXPathi لعدم قبول XML، وLDAPi لعدم وجود LDAP، وSSTI وEL Injection لعدم وجود قوالب على الخادم، وGraphQL Injection لعدم استخدام GraphQL.

## 2. المصادقة والجلسات

الطالبات يدخلن برقم الجوال ورمز تحقق، وقناة تسليم الرمز لم تُحدد بعد. أما الموظفات فبالبريد وكلمة المرور وTOTP، وهو إلزامي للمديرة والمشرفة.

| الثغرات | الحماية | الاختبار |
|---|---|---|
| Broken Authentication, Weak API Authentication, Broken API Authentication, Unauthenticated API Endpoints, Missing Authorization | Guard عام مغلق افتراضيًا | اختبار يمر على كل المسارات ويفشل عند وجود مسار مكشوف بلا قصد |
| Weak Password Policy | 12 حرفًا على الأقل، ورفض كلمات المرور المسرّبة، وArgon2id | اختبار كلمات ضعيفة |
| Brute Force, Credential Stuffing, Password Spraying, Brute Force on API | حدود لكل حساب ولكل IP، وقفل مؤقت متدرج، وتنبيه عند النمط العام | تجاوز الحد والتأكد من الرفض |
| Account/User Enumeration | نفس الرد والتوقيت تقريبًا سواء وُجد الحساب أم لا | مقارنة الردود |
| OTP Brute Force, SMS OTP Flooding | رمز عشوائي آمن بـ 6 أرقام، و5 محاولات، وصلاحية 5 دقائق، وحدود إرسال لكل رقم وIP، وسقف يومي حسب القناة | تجاوز المحاولات والإرسال |
| OTP Verification Bypass, Account Verification Bypass | لا يصدر توكن إلا بعد استهلاك الرمز ذريًا مرة واحدة | إعادة استخدام الرمز وطلبان متزامنان |
| MFA Bypass, MFA Fatigue | التوكن النهائي لا يصدر قبل TOTP، ولا توجد موافقة بالإشعار أصلًا | طلب المسارات المحمية قبل TOTP |
| Password Reset Vulnerability, Weak Password Reset Token, Email Verification Bypass | رمز عشوائي 256 بت، يُخزن hash فقط، ولمرة واحدة، و30 دقيقة، ويلغي كل الجلسات بعد الاستخدام | إعادة الاستخدام وانتهاء الصلاحية |
| Session Fixation, Session Hijacking, Session Prediction, Insecure Session Management, Missing Session Expiration, Insufficient Logout, Insecure Remember Me | توكنات جديدة عند كل دخول، وعشوائية آمنة، وانتهاء صلاحية، وإلغاء من الخادم عند الخروج، ولا توجد ميزة «تذكرني» للموظفات | استخدام التوكن بعد الخروج |

## 3. التحكم في الوصول

| الثغرات | الحماية | الاختبار |
|---|---|---|
| BAC, IDOR, BOLA, IDOR in API Endpoints, Forced Browsing | فحص نطاق كل سجل في طبقة الخدمة، ومعرفات عشوائية من 32 حرفًا، وعدم الاعتماد على صعوبة تخمينها | كل طالبة ومعلمة تحاول الوصول إلى سجل غيرها |
| BFLA, PE, HPE, VPE, Missing Authorization Checks | `@Roles` على كل مسار موظفات، وقراءة الدور والحالة الحالية من القاعدة | مصفوفة اختبار دور × مسار |
| BOPLA, Mass Assignment, Excessive Data Exposure, Improper Property-Level Authorization | DTO منفصل للمدخلات والمخرجات لكل دور، ولا يمكن تعديل `role` و`status` من الملف الشخصي، ولا تصل بيانات الطالبة لغير معلمتها | إرسال حقول زائدة وفحص الرد |
| Insecure Multi-Tenant Isolation, Cross-Tenant Data Leakage | عزل البيانات بين الحلقات عبر `circle_id`، ولا يوجد تعدد مؤسسات حاليًا | معلمة تطلب بيانات حلقة أخرى |
| Path/Directory Traversal, Directory Listing, Arbitrary File Read/Write, LFI, RFI | لا توجد مسارات ملفات مصدرها المستخدم، ولا خدمة ملفات ثابتة من الخادم | payloads من نوع `../` |

## 4. المتصفح ولوحة التحكم

توكنات اللوحة في كوكيز `HttpOnly` و`Secure` و`SameSite=Strict`، ولا تُخزَّن في `localStorage`.

| الثغرات | الحماية | الاختبار |
|---|---|---|
| CSRF | `SameSite=Strict` ورمز CSRF مع الطلبات المعدِّلة | طلب من أصل آخر |
| CORS Misconfiguration, DNS Rebinding | قائمة أصول محددة من الإعداد بلا `*`، والتحقق من `Host` | طلب من أصل غير مسموح |
| CSP Misconfiguration, Missing Security Headers, Clickjacking, Reverse Tabnabbing, Subresource Integrity Bypass | Helmet، وCSP بلا `unsafe-inline`، و`frame-ancestors 'none'`، و`rel="noopener"`، وعدم تحميل سكربتات خارجية | فحص الترويسات في e2e |
| Open Redirect | الرجوع إلى مسارات داخلية فقط | رابط خارجي في `next` |
| Prototype Pollution, DOM Clobbering | رفض `__proto__` و`constructor` في المدخلات، وتحقق صارم للـ JSON | إرسال هذه المفاتيح |
| Web Cache Deception, Web Cache Poisoning, Improper Cache-Control | `Cache-Control: no-store` للاستجابات الخاصة، وعدم تخزينها في CDN | فحص الترويسات |

**غير مستخدمة:** PostMessage لعدم وجود نوافذ متبادلة، وسنراجعها إذا أضفنا iframe.

## 5. رفع الملفات

الرفع للمديرة فقط، ولنوعين: ملف ترجمة (20MB) وملف لغة (2MB). والملف يبقى في الذاكرة ولا يُكتب على القرص أبدًا، ويُحفظ محتواه في القاعدة بعد فحصه كاملًا، ولا يوجد تنزيل أو تقديم للملف نفسه. ولذلك لا ينطبق Zip Slip وLFI وRFI وInsecure File Download.

| الثغرات | الحماية | الاختبار |
|---|---|---|
| Unrestricted/Arbitrary/Malicious File Upload, MIME Type Validation Bypass, File Extension Bypass | الامتداد JSON أو CSV فقط، والمحتوى يُحلل كبيانات ولا يُنفذ أبدًا، وكل صف يُفحص بنوعه وطوله، ورفض أي وسوم HTML في النص | ملف `.exe`، وJSON معطوب، ووسم `<script>` في النص |
| Path Traversal in File Upload | يُحفظ الجزء الأخير من اسم الملف فقط، للعرض، ولا يُستخدم كمسار | اسم `../../etc/passwd.json` |
| Unrestricted Resource Consumption | حد للحجم، وملف واحد، والترجمة تُرفض كاملة ما لم تغطِّ كل الآيات مرة واحدة | ملف 21MB، وآية ناقصة أو مكررة |

## 6. الخادم والبنية التحتية

| الثغرات | الحماية | الاختبار |
|---|---|---|
| SSRF | لا يطلب الخادم روابط مصدرها المستخدم، ومزوّدو الخدمة في قائمة ثابتة | مراجعة كل طلب خارجي |
| Information Disclosure, Improper Error Handling, Stack Trace Exposure, Verbose Error Messages | فلتر أخطاء عام يعيد رسالة عامة و`requestId` | إحداث خطأ وفحص الرد |
| Security Misconfiguration, Debug Mode Enabled, Debug Endpoint Exposure, Exposed Source Maps | التحقق من الإعداد عند التشغيل، ومنع الإقلاع في الإنتاج عند نقص الأسرار، وبدون source maps عامة | فحص نسخة الإنتاج |
| Exposed Environment Variables, API Key Leakage, API Key Reuse, API Key Without Expiration | الأسرار في مدير أسرار المنصة، ومفتاح مستقل لكل بيئة، وتدوير دوري، وفحص الأسرار في CI | gitleaks في CI |
| Insecure Deserialization | JSON فقط، ولا `eval` أو مكتبات تسلسل للكائنات | مراجعة ثابتة |
| HTTP Request Smuggling, Insecure TLS Configuration, DoS, DDoS, Subdomain Takeover, DNS Misconfiguration | Cloudflare أو ما يماثله أمام الخادم، وTLS 1.2 فأعلى، وHSTS، ومراجعة سجلات DNS | فحص TLS، ومراجعة قبل الإطلاق |
| Supply Chain Attack, Dependency Confusion | `package-lock` و`npm ci`، و`allowScripts`، و`npm audit` في CI، وDependabot، ونطاق خاص لأي حزمة داخلية | فشل CI عند ثغرة عالية في الإنتاج |
| ReDoS | حدود طول قبل أي regex، وفحصها في lint | مدخلات طويلة |

## 7. API

| الثغرات | الحماية | الاختبار |
|---|---|---|
| Unrestricted Resource Consumption, API Rate Limiting Bypass, Expensive API Operations Abuse | Throttler عام وأشد على المسارات الحساسة، بتخزين مشترك بين النسخ، وعدم الثقة بـ `X-Forwarded-For` إلا من الـ proxy | تجاوز الحد وتزييف الترويسة |
| Pagination Abuse | حد أقصى 100 عنصر، وترتيب من قائمة مسموحة | طلب `limit` كبير أو سالب |
| Batch Request Abuse | لا توجد endpoints دفعات مفتوحة، وعمليات اللوحة الجماعية بحد أقصى | طلب يتجاوز الحد |
| Missing Request Size Limits, Improper Content-Type Validation | حد 100KB للجسم، وقبول `application/json` فقط | جسم كبير ونوع خاطئ |
| HTTP Method Tampering, Improper HTTP Method Restrictions | مسارات صريحة لكل method، وتعطيل `X-HTTP-Method-Override` | methods غير معرّفة |
| API Documentation Exposure, Swagger UI Exposure | Swagger معطل في الإنتاج | طلب `/docs` في الإنتاج |
| API Versioning Misconfiguration, Deprecated API Exposure | كل المسارات تحت `/v1`، وإزالة النسخ القديمة بجدول معلن | فحص المسارات |

**غير مستخدمة:** GraphQL كله (Authorization Bypass وIntrospection Exposure وQuery Depth/Complexity).

## 8. منطق الأعمال

| الثغرات | الحماية | الاختبار |
|---|---|---|
| Workflow Bypass, Business Logic Flaw | الحالات تتغير من الخادم فقط وبانتقالات محددة، مثل منع إتمام جلسة ملغاة | محاولة تخطي الحالات |
| Race Condition, TOCTOU, Duplicate Transaction, Replay Attack | معاملات وقيود فريدة، واستهلاك ذري للرموز، ومفتاح idempotency عند الحاجة | طلبات متزامنة |
| Booking Manipulation | المعلمة والإدارة فقط تحددان الجلسات، والطالبة تدخل جلستها فقط | طالبة تطلب جلسة غيرها |
| Limit Bypass | فرض الحدود من الخادم فقط | تجاوز الحدود من العميل |

**غير مستخدمة:** Price Manipulation وNegative Quantity Manipulation وPayment Bypass وPayment Status Manipulation وCoupon Abuse وDiscount Manipulation وInventory Manipulation لعدم وجود مدفوعات أو مخزون.

## 9. JWT والتوكنات

- **Access token:** JWT بخوارزمية `ES256` فقط، وصلاحية 15 دقيقة.
- **رمز التسجيل:** الرقم غير المسجل يحصل بعد التحقق على JWT مستقل (`aud` و`typ` خاصان به) صالح 30 دقيقة، ولا يقبله أي مسار آخر. والخادم يأخذ الرقم من هذا الرمز فقط، ويرفض أي `phone` مرسل بجانبه.
- **Refresh token:** قيمة عشوائية وليس JWT، يُخزن hash منه فقط، ويتغير مع كل استخدام.
- **التخزين:** SecureStore في التطبيق، وكوكي `HttpOnly` في اللوحة.

| الثغرات | الحماية | الاختبار |
|---|---|---|
| Algorithm None, Algorithm Confusion, RS256 to HS256 Confusion, Invalid Algorithm Acceptance, Untrusted Algorithm Header, JWT Confusion Attack | قائمة خوارزميات ثابتة في الخادم، وتجاهل اختيار الترويسة | توكنات `none` وHS256 موقعة بالمفتاح العام |
| Weak JWT Secret, JWT Secret Brute Force | زوج مفاتيح ES256 بدل سر نصي، ولا يخرج المفتاح الخاص من مدير الأسرار | مراجعة الإعداد |
| Missing Signature Verification, Improper Signature Validation, Signature Verification Bypass | `verify` فقط من مكتبة موثوقة، ومنع `decode` للقرارات الأمنية | توكن معدّل |
| JWT Key Confusion, Key Injection, JWK Injection, JKU Header Injection, X5U Header Injection, JWT Key ID Injection (kid), JWT Header Parameter Injection, JWT Critical Header Handling Failure | المفاتيح من الإعداد فقط، ورفض `jwk` و`jku` و`x5u` و`crit`، و`kid` من قائمة ثابتة | توكن لكل ترويسة |
| Missing Expiration/Issuer/Audience/Subject/Not Before Validation, Expiration Claim Bypass, Missing JWT Claim Validation, Insufficient Token Validation, Incorrect Clock Skew Handling, Missing Token Type Validation | فرض `exp` و`iss` و`aud` و`sub` و`nbf` و`typ`، وسماحية 30 ثانية للساعة | توكن لكل claim ناقص أو خاطئ |
| Claim Manipulation, Privilege Claim Manipulation, Role Claim Tampering | التوقيع يمنع التعديل، والدور الفعلي يُقرأ من القاعدة | توكن معدّل، وتغيير الدور ثم الطلب |
| JWT Cross-JWT Confusion, JWT Substitution Attack, Cross-Service JWT Trust Abuse | `aud` منفصل للتطبيق واللوحة، مع `typ` لكل نوع | توكن الجوال على اللوحة |
| JWT Parsing Differential, Duplicate JSON Claims, JSON Canonicalization Issues | خادم واحد ومكتبة واحدة، ولا نقبل إلا توكنات موقعة بمفتاحنا، فلا يستطيع المهاجم إنشاء claims مكررة | توكن معدّل يفشل توقيعه |
| Nested JWT Validation Failure, JWE Decryption Misconfiguration | لا نستخدم nested JWT أو JWE، ويُرفض ما عدا JWS | توكن JWE |
| Long-Lived Access Token, Token Replay Attack, JWT Token Replay, JWT Token Theft, JWT Token Reuse | صلاحية قصيرة وTLS يقللان الأثر، لكن لا يمنعان إعادة استخدام توكن مسروق خلال صلاحيته | انتهاء التوكن بعد مدته |
| JWT Token Not Revoked, Missing Token Revocation | حالة الحساب تُفحص في كل طلب، وإلغاء refresh من القاعدة | تعليق الحساب ثم الطلب |
| Refresh Token Reuse, Refresh Token Rotation Failure, Refresh Token Theft, Concurrent Refresh Token Race Condition | تدوير ذري، وإعادة الاستخدام تلغي العائلة كلها | إعادة الاستخدام وطلبان متزامنان |
| Insecure Token Storage, Token Leakage, JWT Token Leakage, Token Exposure in URL, Token Exposure in Logs | Header أو كوكي فقط، وحجب الترويسات الحساسة في السجلات | فحص السجلات |

**غير مستخدمة:** OAuth كله (Insecure OAuth Implementation وRedirect URI Manipulation وState Parameter Missing وAccount Takeover).

## 10. الجلسات المباشرة وWebSocket

| الثغرات | الحماية | الاختبار |
|---|---|---|
| WebSocket Hijacking, WebSocket Authorization Bypass | توكن عند الاتصال، وفحص `Origin`، والتحقق من أن المستخدم طرف في الجلسة، وتوكن غرفة قصير العمر من الخادم | اتصال بلا توكن، وطرف ثالث يدخل الجلسة |
| وعد «لا تسجيل» | تعطيل التسجيل من الخادم، وعدم تخزين الصوت أو المحادثة | مراجعة إعدادات مزوّد الصوت |

## ما يحتاج قرارًا خارج الكود

- **مكان البيانات:** قاعدة Neon الحالية في `us-east-2` بالولايات المتحدة. يجب مراجعة مدى توافق ذلك مع نظام حماية البيانات الشخصية السعودي قبل إدخال بيانات حقيقية.
- **القاصرات:** يبدأ التسجيل من عمر 15 سنة، فيجب مراجعة شرط موافقة ولي الأمر قانونيًا.
- **اختبار الاختراق:** تنفيذه بجهة مستقلة قبل الإطلاق.
