import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createTestApp, register, type TestApp, finishWirdSteps, trackIdOf } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';
type Agent = ReturnType<typeof request.agent>;
const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;

interface PlanBody {
  trackName: string;
  rule: string;
  status: string;
  remainingDays: number;
  streak: number;
  next: { label: string; surah: number; surahName: string; fromAyah: number; toAyah: number; page: number };
  steps: { index: number; done: boolean }[];
  repeat: { count: number; target: number };
  review: { count: number; target: number };
  previous: { page: number; surah: number; fromAyah: number; toAyah: number } | null;
  encouragements: string[];
  week: { kind: string; state: string }[];
  weekSummary: { done: number; total: number };
  todayDone: { wird: boolean; kinds: string[] };
  gate: object | null;
  commitment: number | null;
  progress: number;
}

describe('the student\'s own app data', () => {
  let t: TestApp;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const dashboard = async (token: string) =>
    (await t.http().get('/v1/me/dashboard').set(bearer(token)).expect(200)).body as {
      plan: PlanBody;
      circle: { name: string; teacherName: string; latestTask: { title: string } | null; latestEvaluation: { title: string } | null } | null;
      announcement: { title: string } | null;
      reviewSegments: string[];
    };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('shows a new student their real plan, from their own track', async () => {
    const student = await register(t);
    const { plan, circle, reviewSegments } = await dashboard(student.accessToken);
    expect(plan.trackName).toBe('مسار الحفظ المتأني');
    expect(plan.rule).toContain('نصف وجه');
    expect(plan.next).toMatchObject({ surah: 18, surahName: 'الكهف', fromAyah: 1 });
    expect(plan.next.page).toBeGreaterThan(290);
    expect(plan.status).toBe('regular');
    expect(plan.remainingDays).toBeGreaterThan(1000);
    expect(plan.steps).toHaveLength(6);
    // The first portion has nothing before it to review.
    expect(plan.steps.filter(({ done }) => done).map(({ index }) => index)).toEqual([0]);
    expect(plan.previous).toBeNull();
    expect(plan.repeat).toEqual({ count: 0, target: 35 });
    expect(plan.review).toEqual({ count: 0, target: 5 });
    expect(plan.week).toHaveLength(7);
    expect(circle).toBeNull();
    expect(reviewSegments).toEqual([]);
  });

  it('keeps two students\' work completely apart', async () => {
    const first = await register(t);
    const second = await register(t);
    await t.http().post('/v1/me/wird/steps/1').set(bearer(first.accessToken)).send({ done: true }).expect(204);
    await t.http().post('/v1/me/days/REVIEW/complete').set(bearer(first.accessToken)).send({ detail: 'سُبع ق' }).expect(204);
    await t.http().post('/v1/me/reflections/18').set(bearer(first.accessToken)).send({ body: 'خاص بالأولى' }).expect(204);
    await finishWirdSteps(t, first.accessToken);
    await t.http().post('/v1/me/wird/complete').set(bearer(first.accessToken)).expect(204);

    const other = await dashboard(second.accessToken);
    expect(other.plan.steps.filter(({ done }) => done).map(({ index }) => index)).toEqual([0]);
    expect(other.plan.repeat.count).toBe(0);
    expect(other.plan.todayDone).toEqual({ wird: false, kinds: [] });
    expect(((await t.http().get('/v1/me/reflections/18').set(bearer(second.accessToken)).expect(200)).body as { body: string }).body).toBe('');
    const log = (await t.http().get('/v1/me/log?period=all').set(bearer(second.accessToken)).expect(200)).body as { entries: object[] };
    expect(log.entries).toEqual([]);
  });

  it('remembers the day\'s steps across devices, and starts fresh on the next unit', async () => {
    const { accessToken } = await register(t);
    await t.http().post('/v1/me/wird/steps/1').set(bearer(accessToken)).send({ done: true }).expect(204);
    expect((await dashboard(accessToken)).plan.steps.find(({ index }) => index === 1)?.done).toBe(true);
    await t.http().post('/v1/me/wird/steps/1').set(bearer(accessToken)).send({ done: false }).expect(204);
    expect((await dashboard(accessToken)).plan.steps.find(({ index }) => index === 1)?.done).toBe(false);

    await finishWirdSteps(t, accessToken);
    await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(204);
    const after = (await dashboard(accessToken)).plan;
    expect(after.steps.every(({ done }) => !done)).toBe(true);
    expect(after.previous).toMatchObject({ surah: 18, fromAyah: 1 });
    expect(after.todayDone.wird).toBe(true);
    expect(after.weekSummary.done).toBeGreaterThan(0);
    expect(after.streak).toBe(1);
  });

  it('holds the steps to their order, and refuses a wird with steps left', async () => {
    const { accessToken } = await register(t);
    const step = (index: number, done = true) => t.http().post(`/v1/me/wird/steps/${index}`).set(bearer(accessToken)).send({ done });

    expect((await step(2).expect(409)).body).toMatchObject({ code: 'wird_step_locked' });
    expect((await t.http().post('/v1/me/wird/repeat').set(bearer(accessToken)).expect(409)).body).toMatchObject({ code: 'wird_step_locked' });
    expect((await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(409)).body).toMatchObject({ code: 'wird_steps_incomplete' });

    await step(1).expect(204);
    await step(2).expect(204);
    await step(1, false).expect(204);
    const { steps } = (await dashboard(accessToken)).plan;
    expect(steps.filter(({ done }) => done).map(({ index }) => index)).toEqual([0]);
  });

  it('counts each review of the previous portion, once there is one, up to the target', async () => {
    const { accessToken } = await register(t);
    const review = () => t.http().post('/v1/me/wird/review').set(bearer(accessToken));
    expect((await review().expect(409)).body).toMatchObject({ code: 'nothing_to_review' });
    await t.http().post('/v1/me/wird/steps/0').set(bearer(accessToken)).send({ done: true }).expect(400);

    await finishWirdSteps(t, accessToken);
    await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(204);
    // The next step waits for the review, however it's asked for.
    expect((await t.http().post('/v1/me/wird/steps/1').set(bearer(accessToken)).send({ done: true }).expect(409)).body).toMatchObject({ code: 'wird_step_locked' });

    const results = await Promise.all(Array.from({ length: 7 }, () => review().expect(200)));
    expect(Math.max(...results.map(({ body }) => (body as { count: number }).count))).toBe(5);
    const { plan } = await dashboard(accessToken);
    expect(plan.review.count).toBe(5);
    expect(plan.steps.find(({ index }) => index === 0)?.done).toBe(true);
    await t.http().post('/v1/me/wird/steps/1').set(bearer(accessToken)).send({ done: true }).expect(204);
  });

  it('runs on the steps, targets and words the track sets', async () => {
    const { accessToken, phone } = await register(t);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { phone }, select: { trackTemplateId: true, plan: { select: { id: true } } } });
    const before = await t.prisma.trackTemplate.findUniqueOrThrow({ where: { id: user.trackTemplateId! } });
    await t.prisma.trackTemplate.update({
      where: { id: user.trackTemplateId! },
      data: {
        repeatTarget: 2,
        encouragements: ['بارك الله فيكِ'],
        wirdSteps: [
          { id: 70, kind: 'TASK', title: 'قراءة الورد', subtitle: '' },
          { id: 80, kind: 'REPEAT', title: 'تكرار', subtitle: '' },
        ],
      },
    });
    try {
      const { plan } = await dashboard(accessToken);
      expect(plan.steps.map(({ index }) => index)).toEqual([70, 80]);
      expect(plan.repeat.target).toBe(2);
      expect(plan.encouragements).toEqual(['بارك الله فيكِ']);

      const repeat = () => t.http().post('/v1/me/wird/repeat').set(bearer(accessToken));
      await repeat().expect(409);
      // Nothing counts as done until its own button is pressed.
      await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(409);
      await t.http().post('/v1/me/wird/steps/70').set(bearer(accessToken)).send({ done: true }).expect(204);
      await repeat().expect(200);
      await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(409);
      expect(((await repeat().expect(200)).body as { count: number }).count).toBe(2);
      await t.http().post('/v1/me/wird/review').set(bearer(accessToken)).expect(400);
      await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(204);
    } finally {
      await t.prisma.trackTemplate.update({
        where: { id: user.trackTemplateId! },
        data: { repeatTarget: before.repeatTarget, encouragements: before.encouragements, wirdSteps: Prisma.DbNull },
      });
    }
  });

  it('asks for the surahs a student reviewed', async () => {
    const { accessToken } = await register(t);
    expect((await t.http().post('/v1/me/days/REVIEW/complete').set(bearer(accessToken)).send({}).expect(400)).body).toMatchObject({ code: 'review_detail_required' });
    await t.http().post('/v1/me/days/REVIEW/complete').set(bearer(accessToken)).send({ detail: 'الكهف ومريم وطه' }).expect(204);
  });

  it('finishes the repeat step only through its counter, and stops at the target', async () => {
    const { accessToken, phone } = await register(t);
    await t.http().post('/v1/me/wird/steps/4').set(bearer(accessToken)).send({ done: true }).expect(400);
    for (const index of [1, 2, 3]) {
      await t.http().post(`/v1/me/wird/steps/${index}`).set(bearer(accessToken)).send({ done: true }).expect(204);
    }

    await Promise.all(Array.from({ length: 3 }, () => t.http().post('/v1/me/wird/repeat').set(bearer(accessToken))));
    expect((await dashboard(accessToken)).plan.repeat.count).toBe(3);

    const user = await t.prisma.user.findUniqueOrThrow({ where: { phone }, include: { plan: true } });
    await t.prisma.wirdProgress.update({ where: { planId_unitIndex: { planId: user.plan!.id, unitIndex: 0 } }, data: { repeatCount: 34 } });
    const results = await Promise.all(Array.from({ length: 4 }, () => t.http().post('/v1/me/wird/repeat').set(bearer(accessToken)).expect(200)));
    expect(results.every(({ body }) => (body as { count: number }).count === 35)).toBe(true);
    expect((await dashboard(accessToken)).plan.steps.find(({ index }) => index === 4)?.done).toBe(true);
  });

  it('rejects bad input', async () => {
    const { accessToken } = await register(t);
    await t.http().post('/v1/me/wird/steps/6').set(bearer(accessToken)).send({ done: true }).expect(400);
    await t.http().post('/v1/me/days/OTHER/complete').set(bearer(accessToken)).send({}).expect(400);
    await t.http().post('/v1/me/reflections/18').set(bearer(accessToken)).send({ body: '' }).expect(400);
    await t.http().get('/v1/me/log?period=year').set(bearer(accessToken)).expect(400);
    await t.http().get('/v1/me/dashboard').expect(401);
  });

  it('counts a review day once', async () => {
    const { accessToken } = await register(t);
    await t.http().post('/v1/me/days/REVIEW/complete').set(bearer(accessToken)).send({ detail: 'ق' }).expect(204);
    await t.http().post('/v1/me/days/REVIEW/complete').set(bearer(accessToken)).send({ detail: 'ق' }).expect(204);
    const { reviewsDone } = (await t.http().get('/v1/me/achievements').set(bearer(accessToken)).expect(200)).body as { reviewsDone: number };
    expect(reviewsDone).toBe(1);
  });

  it('builds achievements, log and badge board from real records', async () => {
    const { accessToken } = await register(t);
    const empty = (await t.http().get('/v1/me/achievements?period=month').set(bearer(accessToken)).expect(200)).body as { mastery: number | null; commitmentDays: number; bars: object[]; absenceLevel: number | null };
    expect(empty).toMatchObject({ mastery: null, commitmentDays: 0, absenceLevel: null });
    expect(empty.bars).toHaveLength(4);

    await finishWirdSteps(t, accessToken);
    await t.http().post('/v1/me/wird/complete').set(bearer(accessToken)).expect(204);
    const week = (await t.http().get('/v1/me/achievements?period=week').set(bearer(accessToken)).expect(200)).body as { commitmentDays: number; pages: number; bars: object[] };
    expect(week).toMatchObject({ commitmentDays: 1, pages: 0.5 });
    expect(week.bars).toHaveLength(7);

    const log = (await t.http().get('/v1/me/log').set(bearer(accessToken)).expect(200)).body as { entries: { title: string; status: string }[] };
    expect(log.entries[0].title).toContain('الكهف');

    const board = (await t.http().get('/v1/me/badge-board').set(bearer(accessToken)).expect(200)).body as { badges: { awardedAt: string | null }[]; week: { committedDays: number }; encouragements: object[]; certificate: object | null };
    expect(board.badges).toHaveLength(4);
    expect(board.badges.every(({ awardedAt }) => awardedAt === null)).toBe(true);
    expect(board.week.committedDays).toBe(1);
    expect(board.encouragements).toEqual([]);
    expect(board.certificate).toBeNull();
  });

  it('lists only open tracks publicly, with nothing private', async () => {
    const { body, text } = await t.http().get('/v1/tracks').expect(200);
    const codes = (body as { code: string }[]).map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(['advanced', 'steady', 'stabilization']));
    expect(text).not.toMatch(/gateMode|surahOrder/);

    await t.prisma.trackTemplate.update({ where: { code: 'advanced' }, data: { active: false } });
    try {
      const closed = (await t.http().get('/v1/tracks').expect(200)).body as { code: string }[];
      expect(closed.map(({ code }) => code)).not.toContain('advanced');
    } finally {
      await t.prisma.trackTemplate.update({ where: { code: 'advanced' }, data: { active: true } });
    }
  });

  it('shows the teacher\'s work on the student\'s home screen, and only theirs', async () => {
    const adminEmail = uniqueEmail();
    await t.prisma.user.create({
      data: { email: adminEmail, fullName: 'مديرة', role: 'ADMIN', staffCredential: { create: { passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } } },
    });
    const agent = (): Agent => request.agent(t.app.getHttpServer()).set('Origin', ORIGIN);
    const enroll = async (email: string) => {
      const client = agent();
      const { body } = await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
      const { mfaToken } = body as { mfaToken: string };
      const { secret } = (await client.post('/v1/staff/auth/totp/enroll').send({ mfaToken }).expect(200)).body as { secret: string };
      await client.post('/v1/staff/auth/totp/confirm').send({ mfaToken, code: generateSync({ secret }) }).expect(200);
      return client;
    };
    const admin = await enroll(adminEmail);
    const { id: scopeId } = (await admin.post('/v1/admin/scopes').send({ name: `نطاق ${randomId()}` }).expect(201)).body as { id: string };
    const makeTeacher = async () => {
      const email = uniqueEmail();
      const { body } = await admin.post('/v1/admin/staff').send({ fullName: 'معلمة الحلقة', email, role: 'TEACHER', scopeId }).expect(201);
      const created = body as { staff: { id: string }; setupToken: string };
      await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
      const client = agent();
      await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
      return { id: created.staff.id, client };
    };
    const supervisorEmail = uniqueEmail();
    const { body: supBody } = await admin.post('/v1/admin/staff').send({ fullName: 'مشرفة', email: supervisorEmail, role: 'SUPERVISOR', scopeId }).expect(201);
    await agent().post('/v1/staff/auth/password/set').send({ token: (supBody as { setupToken: string }).setupToken, password: PASSWORD }).expect(204);
    const supervisor = await enroll(supervisorEmail);

    const teacher = await makeTeacher();
    const { id: circleId } = (await supervisor.post('/v1/supervisor/circles').send({ name: 'حلقة التجربة', teacherId: teacher.id, trackId: await trackIdOf(t) }).expect(201)).body as { id: string };
    const mine = await register(t);
    const outsider = await register(t);
    const myId = ((await t.http().get('/v1/me').set(bearer(mine.accessToken)).expect(200)).body as { id: string }).id;
    await supervisor.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId: myId }).expect(204);

    await teacher.client.post('/v1/teacher/tasks').send({ title: 'مهمة حقيقية', recurrence: 'DAILY' }).expect(201);
    await teacher.client
      .post('/v1/teacher/recitations')
      .send({ studentId: myId, surah: 67, fromAyah: 1, toAyah: 12, score: 8, segmentStatus: 'NEEDS_REVIEW', attendance: 'PRESENT', note: 'راجعي المدود' })
      .expect(201);
    await admin.post('/v1/admin/broadcasts').send({ kind: 'ANNOUNCEMENT', title: 'لهذه الحلقة', body: 'نص', audience: { type: 'CIRCLE', circleId } }).expect(201);

    const home = await dashboard(mine.accessToken);
    expect(home.circle).toMatchObject({ name: 'حلقة التجربة', teacherName: 'معلمة الحلقة', latestTask: { title: 'مهمة حقيقية' } });
    expect(home.circle?.latestEvaluation?.title).toContain('الملك');
    expect(home.reviewSegments).toEqual(['الملك · 1-12']);
    expect(home.announcement?.title).toBe('لهذه الحلقة');

    const other = await dashboard(outsider.accessToken);
    expect(other.circle).toBeNull();
    expect(other.reviewSegments).toEqual([]);
    expect(other.announcement?.title).not.toBe('لهذه الحلقة');

    // Marked mastered later, it leaves the review list.
    await teacher.client
      .post('/v1/teacher/recitations')
      .send({ studentId: myId, surah: 67, fromAyah: 1, toAyah: 12, score: 10, segmentStatus: 'MASTERED', attendance: 'PRESENT' })
      .expect(201);
    expect((await dashboard(mine.accessToken)).reviewSegments).toEqual([]);

    // Removing the student's account takes every new kind of record with it.
    await t.http().delete('/v1/me').set(bearer(mine.accessToken)).expect(204);
    expect(await t.prisma.dayCompletion.count({ where: { studentId: myId } })).toBe(0);
    expect(await t.prisma.tadabburReflection.count({ where: { studentId: myId } })).toBe(0);
  }, 120_000);
});
