// Creates the first administrator, or issues a new setup link for an existing one.
// Usage: npm run admin:create -- name@example.com "الاسم الكامل"
import { createHash, randomBytes } from 'node:crypto';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const SETUP_TOKEN_MS = 72 * 60 * 60 * 1000;

const [email, ...nameParts] = process.argv.slice(2);
const fullName = nameParts.join(' ').trim();
if (!email?.includes('@') || !fullName) {
  console.error('Usage: npm run admin:create -- name@example.com "Full Name"');
  process.exit(1);
}

const schema = process.env.DATABASE_SCHEMA;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }, schema ? { schema } : undefined),
});
const setupToken = randomBytes(32).toString('base64url');

const user = await prisma.user.upsert({
  where: { email: email.toLowerCase() },
  update: {},
  create: { email: email.toLowerCase(), fullName, role: 'ADMIN', staffCredential: { create: {} } },
  select: { id: true, role: true },
});
if (user.role !== 'ADMIN') {
  console.error('This email belongs to a non-administrator account.');
  process.exit(1);
}

await prisma.staffCredential.upsert({
  where: { userId: user.id },
  update: { passwordHash: null, totpSecretEncrypted: null, totpEnabledAt: null, totpLastStep: null, failedAttempts: 0, lockedUntil: null },
  create: { userId: user.id },
});
await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
await prisma.staffSecurityToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } });
await prisma.staffSecurityToken.create({
  data: {
    userId: user.id,
    purpose: 'SET_PASSWORD',
    tokenHash: createHash('sha256').update(setupToken).digest('hex'),
    expiresAt: new Date(Date.now() + SETUP_TOKEN_MS),
  },
});
await prisma.auditLog.create({ data: { actorId: user.id, action: 'staff.setup_issued_by_cli', targetType: 'user', targetId: user.id } });
await prisma.$disconnect();

console.log(`Setup token (valid for 72 hours, shown once):\n${setupToken}`);
