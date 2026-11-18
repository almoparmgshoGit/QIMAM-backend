# رفع الباك اند على Hostinger VPS

قاعدة البيانات على Neon وتفضل زي ما هي. السيرفر بيشغّل Node + PM2 خلف Nginx مع HTTPS، ومعاه coturn للمكالمات الصوتية.

في الأوامر تحت: `api.example.com` = الدومين الفرعي بتاع الـ API، و`SERVER_IP` = IP السيرفر من hPanel.

## 1. إعداد الـ VPS من hPanel

- نظام التشغيل: **Ubuntu 24.04** (بدون لوحة تحكم).
- من **DNS Zone** للدومين: سجل `A` باسم `api` يشاور على `SERVER_IP`. ولو هتستخدم TURN: سجل `A` باسم `turn` لنفس الـ IP.

## 2. تجهيز السيرفر (مرة واحدة)

```bash
ssh root@SERVER_IP

apt update && apt upgrade -y
apt install -y git nginx certbot python3-certbot-nginx build-essential ufw

# Node 24 (نفس النسخة اللي على جهاز التطوير)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
npm install -g pm2

# مستخدم للتطبيق بدل root
adduser --disabled-password --gecos "" qimam
mkdir -p /var/www /var/lib/qimam/uploads
chown -R qimam:qimam /var/lib/qimam

# الجدار الناري
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

## 3. جلب الكود

الريبو خاص، فاعمل **Deploy key** للقراءة فقط:

```bash
su - qimam
ssh-keygen -t ed25519 -C "qimam-vps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

انسخ المفتاح وضيفه في GitHub: الريبو ← Settings ← Deploy keys ← Add (بدون write access). بعدها:

```bash
git clone git@github.com:almoparmgshoGit/QIMAM-backend.git ~/backend
cd ~/backend
```

السيرفر بيتابع `main`، و`deploy.sh` بيسحب منه.

## 4. ملف `.env` للإنتاج

```bash
nano ~/backend/.env
chmod 600 ~/backend/.env
```

```env
NODE_ENV=production
PORT=4000

DATABASE_URL="...pooler... من Neon"
DIRECT_URL="...direct... من Neon"

# مفاتيح جديدة للإنتاج، مش نفس مفاتيح التطوير (الأوامر تحت)
JWT_PRIVATE_KEY_BASE64=""
JWT_KEY_ID="k1"
OTP_PEPPER=""
TOTP_ENCRYPTION_KEY=""

# console ممنوع في الإنتاج والسيرفر مش هيشتغل بيه
OTP_DELIVERY="authentica"
AUTHENTICA_API_KEY=""
AUTHENTICA_METHOD="sms"

# مراجعة App Store / Google Play: رقم واحد يدخل بكود ثابت من 4 أرقام من غير SMS.
# الاتنين مع بعض أو ولا واحد، وامسحهم بعد ما المراجعة تخلص.
# REVIEW_PHONE="+966500000000"
# REVIEW_CODE="1234"

MAIL_DELIVERY="smtp"
SMTP_URL="smtps://user:pass@smtp.hostinger.com:465"
MAIL_FROM="Qimam <no-reply@example.com>"

# دومين الداشبورد بالـ https (أول واحد بيتستخدم في روابط استعادة الحساب)
ADMIN_ORIGINS="https://admin.example.com"

# Nginx على نفس الجهاز
TRUST_PROXY="loopback"

UPLOADS_DIR=/var/lib/qimam/uploads

TURN_URLS="turn:turn.example.com:3478,turns:turn.example.com:5349"
TURN_SECRET=""
```

توليد المفاتيح على السيرفر:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | base64 -w0   # JWT_PRIVATE_KEY_BASE64
openssl rand -base64 32                                                        # OTP_PEPPER
openssl rand -base64 32                                                        # TOTP_ENCRYPTION_KEY
openssl rand -hex 32                                                           # TURN_SECRET
```

> تنبيه: لو قاعدة بيانات الإنتاج هي نفس اللي كنت بتجرب عليها، تغيير `OTP_PEPPER` أو `TOTP_ENCRYPTION_KEY` هيبوّظ الأكواد وأسرار الـ authenticator المحفوظة. الأفضل تعمل branch أو database جديدة على Neon للإنتاج.

## 5. أول تشغيل

```bash
cd ~/backend
bash deploy/deploy.sh
```

السكريبت بيعمل: `git pull` ← `npm ci` ← `prisma generate` ← `build` ← `prisma migrate deploy` ← تشغيل/إعادة تشغيل PM2.

لو محتاج حساب أدمن أول مرة: `npm run admin:create`.

تشغيل تلقائي بعد إعادة تشغيل السيرفر (نفّذ الأمر اللي بيطبعه كـ root):

```bash
pm2 startup systemd -u qimam --hp /home/qimam
pm2 save
```

## 6. Nginx و HTTPS (كـ root)

```bash
cp /home/qimam/backend/deploy/nginx-qimam-api.conf /etc/nginx/sites-available/qimam-api
sed -i 's/api.example.com/api.YOURDOMAIN.com/' /etc/nginx/sites-available/qimam-api
ln -s /etc/nginx/sites-available/qimam-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d api.YOURDOMAIN.com --redirect -m you@example.com --agree-tos -n
```

اختبار: `curl -i https://api.YOURDOMAIN.com/v1/...` على أي endpoint عام.

## 7. TURN للمكالمات الصوتية (coturn)

```bash
apt install -y coturn
certbot certonly --nginx -d turn.YOURDOMAIN.com
```

`/etc/turnserver.conf`:

```conf
listening-port=3478
tls-listening-port=5349
realm=turn.YOURDOMAIN.com
use-auth-secret
static-auth-secret=نفس_قيمة_TURN_SECRET
cert=/etc/letsencrypt/live/turn.YOURDOMAIN.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.YOURDOMAIN.com/privkey.pem
min-port=49152
max-port=65535
no-cli
fingerprint
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

```bash
# coturn لازم يقرأ الشهادة
chmod -R o+rX /etc/letsencrypt/live /etc/letsencrypt/archive
ufw allow 3478 && ufw allow 5349
ufw allow 49152:65535/udp
systemctl enable --now coturn
```

## 8. التحديثات بعد كده

```bash
ssh qimam@SERVER_IP
cd ~/backend && bash deploy/deploy.sh
```

## 9. أوامر مفيدة

```bash
pm2 logs qimam-api        # اللوجز
pm2 restart qimam-api     # إعادة تشغيل
pm2 monit                 # الذاكرة والمعالج
```

## بعد الرفع

- التطبيق (qimam-app) والداشبورد (qimam-admin) لازم يشاوروا على `https://api.YOURDOMAIN.com`.
- الملفات المرفوعة في `/var/lib/qimam/uploads` على السيرفر بس، فاعمل لها نسخ احتياطي (أو فعّل Backups من hPanel).
