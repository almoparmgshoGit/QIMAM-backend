import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OtpDelivery } from '../src/auth/otp-delivery.js';
import { LeakedPasswordChecker } from '../src/auth/password.service.js';
import { StaffMailer, type StaffMail } from '../src/auth/staff-mailer.js';

export const LEAKED_PASSWORD = 'correct-horse-battery-staple';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  sent: { phone: string; code: string }[];
  mails: StaffMail[];
  http: () => ReturnType<typeof request>;
  codeFor: (phone: string) => string;
}

/** The real application with its real protections. Only code delivery is captured instead of printed. */
export async function createTestApp({ rateLimits = false } = {}): Promise<TestApp> {
  const sent: TestApp['sent'] = [];
  const mails: StaffMail[] = [];
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OtpDelivery)
    .useValue({ deliver: (phone: string, code: string) => Promise.resolve(void sent.push({ phone, code })) })
    .overrideProvider(StaffMailer)
    .useValue({ send: (mail: StaffMail) => Promise.resolve(void mails.push(mail)) })
    // No call to the outside service during tests. One known password stands in for a breached one.
    .overrideProvider(LeakedPasswordChecker)
    .useValue({ isLeaked: (password: string) => Promise.resolve(password === LEAKED_PASSWORD) });
  if (!rateLimits) {
    builder = builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  // Most tests begin after acceptance. The admission tests turn this back on.
  await app.get(PrismaService).appSetting.upsert({ where: { key: 'admission' }, create: { key: 'admission', value: { required: false } }, update: { value: { required: false } } });

  return {
    app,
    prisma: app.get(PrismaService),
    sent,
    mails,
    http: () => request(app.getHttpServer()),
    codeFor: (phone) => {
      const code = sent.filter((item) => item.phone === phone).at(-1)?.code;
      if (!code) throw new Error(`no code was sent to ${phone}`);
      return code;
    },
  };
}

let phoneCounter = Math.floor(Math.random() * 9_000_000);

/** A new valid Saudi number for each test, so no test meets another's limits. */
export const newPhone = (): string => `+96650${String(1_000_000 + (phoneCounter++ % 8_000_000))}`;

export const REGISTRATION = {
  fullName: 'نورة محمد العتيبي',
  country: 'السعودية',
  ageBand: '19',
  trackId: 'steady',
  trackStart: null,
  pledgesAccepted: true,
} as const;

/** A track's id by its code. A circle needs a track, and `register` puts a student on the REGISTRATION one. */
export async function trackIdOf(t: TestApp, code: string = REGISTRATION.trackId): Promise<string> {
  return (await t.prisma.trackTemplate.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;
}

/**
 * A staff session lasts 15 minutes, and a long file against a remote database outlasts it.
 * Renews the agents a file keeps from its start, between tests, before that happens.
 */
export function keepStaffSignedIn(agents: () => ReturnType<typeof request.agent>[]): void {
  let renewedAt = Date.now();
  beforeEach(async () => {
    if (Date.now() - renewedAt < 10 * 60 * 1000) return;
    renewedAt = Date.now();
    for (const agent of agents()) await agent.post('/v1/staff/auth/refresh').expect(204);
  });
}

export async function register(t: TestApp, phone = newPhone()) {
  await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'register' }).expect(202);
  const { body } = await t
    .http()
    .post('/v1/auth/otp/verify')
    .send({ phone, code: t.codeFor(phone), registration: REGISTRATION })
    .expect(200);
  return { phone, ...(body as { accessToken: string; refreshToken: string; expiresIn: number }) };
}

/** Moves a number's challenges into the past, in place of waiting out the resend cooldown. */
export async function passCooldown(t: TestApp, phone: string): Promise<void> {
  await t.prisma.otpChallenge.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
}

/** Marks every step of the student's current unit done, as a student would before finishing their wird. */
export async function finishWirdSteps(t: TestApp, token: string): Promise<void> {
  const { body } = await t.http().get('/v1/me').set({ Authorization: `Bearer ${token}` });
  const plan = await t.prisma.studentPlan.findUnique({ where: { studentId: (body as { id: string }).id } });
  if (!plan) return;
  const key = { planId: plan.id, unitIndex: plan.completedUnits };
  const done = { doneSteps: [1, 2, 3, 5], repeatCount: 35, reviewCount: 5 };
  await t.prisma.wirdProgress.upsert({ where: { planId_unitIndex: key }, create: { ...key, ...done }, update: done });
}
