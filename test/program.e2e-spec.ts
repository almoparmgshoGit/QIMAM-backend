import zlib from 'node:zlib';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { SURAHS } from '../src/common/surahs.js';
import { NotificationsService } from '../src/program/notifications.service.js';
import { createTestApp, keepStaffSignedIn, newPhone, nextWirdDay, register, type TestApp, finishWirdSteps, trackIdOf } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';
const MASTERED = { score: 9, segmentStatus: 'MASTERED', attendance: 'PRESENT' };
type Agent = ReturnType<typeof request.agent>;

const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;
const dateOnly = (daysFromToday: number) => new Date(Date.now() + daysFromToday * 86_400_000);

describe('program', () => {
  let t: TestApp;
  let admin: Agent;
  let scopeA: string;
  let scopeB: string;
  let supervisorA: Agent;
  let supervisorB: Agent;
  const agent = (): Agent => request.agent(t.app.getHttpServer()).set('Origin', ORIGIN);

  async function enroll(email: string): Promise<Agent> {
    const client = agent();
    const { body } = await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    const { mfaToken } = body as { mfaToken: string };
    const { secret } = (await client.post('/v1/staff/auth/totp/enroll').send({ mfaToken }).expect(200)).body as { secret: string };
    await client.post('/v1/staff/auth/totp/confirm').send({ mfaToken, code: generateSync({ secret }) }).expect(200);
    return client;
  }

  async function newStaff(role: 'TEACHER' | 'SUPERVISOR', scopeId: string, section: 'WOMEN' | 'MEN' = 'WOMEN') {
    const email = uniqueEmail();
    const { body } = await admin.post('/v1/admin/staff').send({ fullName: `${role} اختبار`, email, role, scopeId, section }).expect(201);
    const created = body as { staff: { id: string }; setupToken: string };
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
    if (role === 'SUPERVISOR') return { id: created.staff.id, client: await enroll(email), email };
    const client = agent();
    await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    return { id: created.staff.id, client, email };
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newStudent(section: 'women' | 'men' = 'women') {
    const reg = await register(t, newPhone(), section);
    const { id } = (await t.http().get('/v1/me').set(bearer(reg.accessToken)).expect(200)).body as { id: string };
    return { ...reg, id };
  }

  /** A copy of the REGISTRATION track whose students recite by recording, so it is open to the men's section. */
  async function recordedTrack() {
    const { id: _id, code: _code, createdAt: _createdAt, updatedAt: _updatedAt, ...steady } = await t.prisma.trackTemplate.findUniqueOrThrow({ where: { code: 'steady' } });
    const code = `recorded-${randomId().slice(0, 8)}`;
    return t.prisma.trackTemplate.create({
      data: { ...steady, code, name: `مسار ${code}`, recitationMode: 'RECORDING', wirdSteps: steady.wirdSteps ?? undefined, encouragements: steady.encouragements ?? undefined },
      select: { id: true, code: true },
    });
  }

  /** A teacher and circle in scope A, with one student on a plan. */
  async function classroom() {
    const teacher = await newStaff('TEACHER', scopeA);
    const { id: circleId } = (await supervisorA.post('/v1/supervisor/circles').send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId: teacher.id, trackId: await trackIdOf(t) }).expect(201)).body as { id: string };
    const student = await newStudent();
    await supervisorA.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId: student.id }).expect(204);
    return { teacher, circleId, student };
  }

  /** The student's next surah is the given short one, and the track is surah by surah. */
  async function onShortPlan(studentId: string, surahs: number[], gateMode: 'ACTIVE' | 'RELAXED' | 'TEACHER' | 'PAUSED' = 'ACTIVE') {
    const { body } = await admin
      .post('/v1/admin/tracks')
      .send({ kind: 'MEMORIZATION', name: `مسار ${randomId().slice(0, 6)}`, audience: 'اختبار', durationMonths: 1, memorizationOrder: 'FORWARD', dailyUnit: 'SURAH', wirdDays: [0, 1, 2, 3, 4, 5, 6], consolidationDays: 0 })
      .expect(201);
    const { id: templateId } = body as { id: string };
    await admin.patch(`/v1/admin/gate-rules/tracks/${templateId}`).send({ mode: gateMode }).expect(204);
    await t.prisma.studentPlan.update({ where: { studentId }, data: { templateId, surahOrder: surahs, completedUnits: 0 } });
    return templateId;
  }

  const completeNow = (token: string) => t.http().post('/v1/me/wird/complete').set(bearer(token));
  const complete = (token: string) => ({
    expect: async (status: number) => {
      await finishWirdSteps(t, token);
      return completeNow(token).expect(status);
    },
  });
  const program = async (token: string) => (await t.http().get('/v1/me/program').set(bearer(token)).expect(200)).body as ProgramBody;

  keepStaffSignedIn(() => [admin, supervisorA, supervisorB]);

  beforeAll(async () => {
    t = await createTestApp();
    const email = uniqueEmail();
    await t.prisma.user.create({
      data: {
        email,
        fullName: 'مديرة الاختبار',
        role: 'ADMIN',
        staffCredential: { create: { passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } },
      },
    });
    admin = await enroll(email);
    scopeA = ((await admin.post('/v1/admin/scopes').send({ name: `أ ${randomId()}` }).expect(201)).body as { id: string }).id;
    scopeB = ((await admin.post('/v1/admin/scopes').send({ name: `ب ${randomId()}` }).expect(201)).body as { id: string }).id;
    supervisorA = (await newStaff('SUPERVISOR', scopeA)).client;
    supervisorB = (await newStaff('SUPERVISOR', scopeB)).client;
  }, 180_000);
  afterAll(async () => {
    await t.app.close();
  });

  describe('plans', () => {
    it('begins at sign-up, on the student\'s track, from the track\'s first surah', async () => {
      const student = await newStudent();
      const { summary, week } = await program(student.accessToken);
      expect(summary.status).toBe('regular');
      expect(summary.nextLabel).toContain('الكهف');
      expect(week?.days).toHaveLength(7);
    });

    it('begins at Al-Fatiha when a student on the stabilization track chose to', async () => {
      const phone = newPhone();
      await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'register' }).expect(202);
      const { body } = await t
        .http()
        .post('/v1/auth/otp/verify')
        .send({ phone, code: t.codeFor(phone), registration: { fullName: 'سارة علي أحمد', country: 'مصر', ageBand: '20', section: 'women', trackId: 'stabilization', trackStart: 'fatiha', pledgesAccepted: true } })
        .expect(200);
      const { accessToken } = body as { accessToken: string };
      expect((await program(accessToken)).summary.nextLabel).toContain('الفاتحة');
    });

    it('advances one unit at a time, and a double tap counts once', async () => {
      const { student } = await classroom();
      const before = (await program(student.accessToken)).summary.nextLabel;
      await finishWirdSteps(t, student.accessToken);
      const results = await Promise.all([completeNow(student.accessToken), completeNow(student.accessToken)]);
      expect(results.map(({ status }) => status).sort()).toEqual([204, 409]);
      const { summary } = await program(student.accessToken);
      expect(summary.completedUnits).toBe(1);
      expect(summary.nextLabel).not.toBe(before);
    });

    it('counts a teacher\'s mastered recitation that covers the next unit, and nothing else', async () => {
      const { teacher, student } = await classroom();
      const record = (body: object) => teacher.client.post('/v1/teacher/recitations').send({ studentId: student.id, surah: 18, fromAyah: 1, toAyah: 10, ...MASTERED, ...body }).expect(201);
      const done = async () => (await program(student.accessToken)).summary.completedUnits;

      await record({ segmentStatus: 'NEEDS_REVIEW' });
      expect(await done()).toBe(0);
      await record({ score: null, segmentStatus: null, attendance: 'ABSENT' });
      expect(await done()).toBe(0);
      await record({ surah: 19 });
      expect(await done()).toBe(0);
      await record({});
      expect(await done()).toBeGreaterThan(0);
    });

    it('measures how far behind a student is and shows it to the teacher and supervisor', async () => {
      const { teacher, student, circleId } = await classroom();
      await t.prisma.studentPlan.update({ where: { studentId: student.id }, data: { startOn: dateOnly(-14) } });

      const { items } = (await teacher.client.get('/v1/teacher/students').expect(200)).body as { items: { status: string; delay: string; commitment: number }[] };
      expect(items[0]).toMatchObject({ status: 'late', commitment: 0 });
      expect(items[0].delay).toBeTruthy();

      const plans = (await supervisorA.get(`/v1/supervisor/plans?circleId=${circleId}`).expect(200)).body as PlansBody;
      expect(plans.stats).toMatchObject({ onPlan: 1, behind: 1, committed: 0 });
      expect(plans.behind[0].studentId).toBe(student.id);
      expect(plans.circles[0].commitment).toBe(0);
    });

    it('gives no plan on the correction track, which has no memorization', async () => {
      const student = await newStudent();
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; code: string }[];
      const correction = tracks.find(({ code }) => code === 'correction')!;
      await t.prisma.studentPlan.delete({ where: { studentId: student.id } });
      await t.prisma.user.update({ where: { id: student.id }, data: { trackTemplateId: correction.id, trackId: null } });
      expect((await program(student.accessToken)).summary).toMatchObject({ status: 'no_plan', commitment: null });
      const { body } = await t.http().get('/v1/me/dashboard').set(bearer(student.accessToken)).expect(200);
      expect((body as { plan: object | null }).plan).toBeNull();
    });

    it('lets a student change track until work has begun', async () => {
      const student = await newStudent();
      await t.http().patch('/v1/me').set(bearer(student.accessToken)).send({ track: { trackId: 'advanced', trackStart: null } }).expect(200);
      const before = (await program(student.accessToken)).summary;
      expect(before.completedUnits).toBe(0);
      await complete(student.accessToken).expect(204);
      await t.http().patch('/v1/me').set(bearer(student.accessToken)).send({ track: { trackId: 'steady', trackStart: null } }).expect(409);
    });

    it('takes the plan with the account when it is deleted', async () => {
      const { student } = await classroom();
      await complete(student.accessToken).expect(204);
      await t.http().delete('/v1/me').set(bearer(student.accessToken)).expect(204);
      expect(await t.prisma.studentPlan.count({ where: { studentId: student.id } })).toBe(0);
    });
  });

  describe('gates', () => {
    async function atGate(mode: 'ACTIVE' | 'RELAXED' | 'TEACHER' | 'PAUSED' = 'ACTIVE') {
      const room = await classroom();
      await onShortPlan(room.student.id, [113, 114], mode);
      await complete(room.student.accessToken).expect(204);
      const gates = (await room.teacher.client.get('/v1/teacher/gates').expect(200)).body as GateBody[];
      return { ...room, gate: gates[0] };
    }
    const wrapAll = async (token: string, surah: number, times: number) => {
      for (let i = 0; i < times; i++) await t.http().post(`/v1/me/gates/${surah}/wrap`).set(bearer(token)).expect(200);
    };
    const approve = (room: { teacher: { client: Agent } }, id: string, score: number | null) =>
      room.teacher.client.post(`/v1/teacher/gates/${id}/approve`).send({ score });
    const makeDue = (id: string) => t.prisma.surahGate.update({ where: { id }, data: { testDueOn: dateOnly(-1) } });

    it('opens after the last unit of a surah and blocks the next one', async () => {
      const room = await atGate();
      expect(room.gate).toMatchObject({ surah: 113, surahName: 'الفلق', conditionsMet: false, readyForDecision: false });
      expect((await complete(room.student.accessToken).expect(409)).body).toMatchObject({ code: 'gate_pending' });
      expect((await program(room.student.accessToken)).summary.status).toBe('awaiting_gate');
    });

    it('needs tafsir, the reflection, the wrap count, the exam date and a passing score, in that order', async () => {
      const room = await atGate();
      const token = room.student.accessToken;
      const { id } = room.gate;

      expect((await approve(room, id, 9).expect(409)).body).toMatchObject({ code: 'gate_conditions_unmet' });
      await t.http().post('/v1/me/gates/113/tafsir').set(bearer(token)).expect(204);
      await wrapAll(token, 113, 5);
      expect((await approve(room, id, 9).expect(409)).body).toMatchObject({ code: 'gate_conditions_unmet' });
      await t.http().post('/v1/me/reflections/113').set(bearer(token)).send({ body: 'ما استفدته من الدرس' }).expect(204);
      await t.prisma.surahGate.update({ where: { id }, data: { wrapCount: 4 } });
      expect((await approve(room, id, 9).expect(409)).body).toMatchObject({ code: 'gate_conditions_unmet' });
      await wrapAll(token, 113, 1);
      expect((await approve(room, id, 9).expect(409)).body).toMatchObject({ code: 'exam_not_due' });

      await makeDue(id);
      await approve(room, id, null).expect(400);
      expect((await approve(room, id, 6).expect(409)).body).toMatchObject({ code: 'score_below_pass' });
      await approve(room, id, 7).expect(204);

      // Decided once, and the next surah opens, on the next day.
      await approve(room, id, 9).expect(404);
      await nextWirdDay(t, token);
      await complete(token).expect(204);
      const { summary } = await program(token);
      expect(summary).toMatchObject({ passedSurahs: 1 });

      const badges = (await t.http().get('/v1/me/badges').set(bearer(token)).expect(200)).body as { code: string; awardedAt: string | null }[];
      expect(badges.find(({ code }) => code === 'surahComplete')?.awardedAt).toBeTruthy();
    });

    it('takes one decision from simultaneous approvals', async () => {
      const room = await atGate('TEACHER');
      const results = await Promise.all([approve(room, room.gate.id, 8), approve(room, room.gate.id, 8)]);
      expect(results.map(({ status }) => status).sort()).toEqual([204, 409]);
    });

    it('is decided by the teacher\'s score alone in teacher mode', async () => {
      const room = await atGate('TEACHER');
      expect(room.gate).toMatchObject({ mode: 'TEACHER', conditionsMet: true, readyForDecision: true });
      await approve(room, room.gate.id, 8).expect(204);
    });

    it('needs no exam or wrap in relaxed mode', async () => {
      const room = await atGate('RELAXED');
      expect(room.gate.exam.required).toBe(false);
      expect(room.gate.wrap.required).toBe(false);
      await approve(room, room.gate.id, null).expect(409);
      await t.http().post('/v1/me/gates/113/tafsir').set(bearer(room.student.accessToken)).expect(204);
      await approve(room, room.gate.id, null).expect(409);
      await t.http().post('/v1/me/reflections/113').set(bearer(room.student.accessToken)).send({ body: 'فائدة' }).expect(204);
      await approve(room, room.gate.id, null).expect(204);
    });

    it('does not exist in paused mode', async () => {
      const room = await classroom();
      await onShortPlan(room.student.id, [113, 114], 'PAUSED');
      await complete(room.student.accessToken).expect(204);
      await nextWirdDay(t, room.student.accessToken);
      await complete(room.student.accessToken).expect(204);
      expect((await room.teacher.client.get('/v1/teacher/gates').expect(200)).body).toEqual([]);
      expect((await program(room.student.accessToken)).summary.status).toBe('completed');
    });

    it('requires a surah\'s published lesson and practical tasks', async () => {
      const room = await atGate('RELAXED');
      const saved = (await admin
        .put('/v1/admin/tadabbur/113')
        .send({ lessonType: 'مسجل', sheikh: 'الشيخ', schedule: 'الخميس', link: 'https://example.com/a', journaling: true, published: true, tasks: [{ title: 'مهمة', note: 'ملاحظة' }] })
        .expect(200)).body as { content: { tasks: { id: string }[] } };
      try {
        const token = room.student.accessToken;
        await t.http().post('/v1/me/gates/113/tafsir').set(bearer(token)).expect(204);
        await t.http().post('/v1/me/reflections/113').set(bearer(token)).send({ body: 'فائدة' }).expect(204);
        await approve(room, room.gate.id, null).expect(409);
        await t.http().post('/v1/me/gates/113/lesson').set(bearer(token)).expect(204);
        await approve(room, room.gate.id, null).expect(409);
        await t.http().post(`/v1/me/practical/${saved.content.tasks[0].id}`).set(bearer(token)).expect(204);
        await t.http().post(`/v1/me/practical/${saved.content.tasks[0].id}`).set(bearer(token)).expect(204);

        // The student's word alone doesn't pass the gate. A rejection sends them back to attend.
        const { body: refused } = await approve(room, room.gate.id, null).expect(409);
        expect(refused).toMatchObject({ code: 'lesson_not_confirmed' });
        await room.teacher.client.post(`/v1/teacher/gates/${room.gate.id}/lesson/reject`).expect(204);
        await approve(room, room.gate.id, null).expect(409);
        await t.http().post('/v1/me/gates/113/lesson').set(bearer(token)).expect(204);
        await room.teacher.client.post(`/v1/teacher/gates/${room.gate.id}/lesson/confirm`).expect(204);
        await approve(room, room.gate.id, null).expect(204);
      } finally {
        await admin.put('/v1/admin/tadabbur/113').send({ lessonType: 'مسجل', sheikh: 'الشيخ', schedule: 'الخميس', link: null, journaling: true, published: false, tasks: [] }).expect(200);
      }
    });

    it('shows the teacher what the student wrote about the lesson', async () => {
      const room = await atGate('TEACHER');
      await t.http().post('/v1/me/reflections/113').set(bearer(room.student.accessToken)).send({ body: 'تدبرتُ الآية الأولى' }).expect(204);
      const gates = (await room.teacher.client.get('/v1/teacher/gates').expect(200)).body as { reflection: string | null }[];
      expect(gates[0].reflection).toBe('تدبرتُ الآية الأولى');
    });

    it('can be returned, which resets the wrap and the test date, and stays open', async () => {
      const room = await atGate();
      await wrapAll(room.student.accessToken, 113, 2);
      await makeDue(room.gate.id);
      await room.teacher.client.post(`/v1/teacher/gates/${room.gate.id}/return`).send({ note: 'راجعي الآية الثالثة' }).expect(204);
      const { gate } = await program(room.student.accessToken);
      expect(gate).toMatchObject({ returnNote: 'راجعي الآية الثالثة', status: 'PENDING', wrap: { count: 0 }, exam: { due: false } });
    });

    it('applies an exception only to its student, and only until it expires', async () => {
      const room = await atGate();
      const other = await atGate();
      const add = (body: object) => admin.post('/v1/admin/gate-exceptions').send({ studentId: room.student.id, reason: 'ظرف صحي', ...body }).expect(201);

      await add({ type: 'SKIP_WRAP' });
      const skipped = (await room.teacher.client.get('/v1/teacher/gates').expect(200)).body as GateBody[];
      expect(skipped[0].wrap.required).toBe(false);
      expect(((await other.teacher.client.get('/v1/teacher/gates').expect(200)).body as GateBody[])[0].wrap.required).toBe(true);

      await add({ type: 'SKIP_TAFSIR', expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(((await room.teacher.client.get('/v1/teacher/gates').expect(200)).body as GateBody[])[0].tafsir.required).toBe(true);

      await makeDue(room.gate.id);
      await add({ type: 'POSTPONE_EXAM', expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() });
      expect(((await room.teacher.client.get('/v1/teacher/gates').expect(200)).body as GateBody[])[0].exam.due).toBe(false);
    });

    it('requires a date for a postponed exam', async () => {
      const student = await newStudent();
      await admin.post('/v1/admin/gate-exceptions').send({ studentId: student.id, reason: 'x', type: 'POSTPONE_EXAM' }).expect(400);
    });

    it('answers 404 to another teacher, and a student can only touch their own gate', async () => {
      const room = await atGate('TEACHER');
      const other = await classroom();
      expect((await other.teacher.client.get('/v1/teacher/gates').expect(200)).body).toEqual([]);
      await approve(other, room.gate.id, 9).expect(404);
      await other.teacher.client.post(`/v1/teacher/gates/${room.gate.id}/return`).send({ note: null }).expect(404);
      await t.http().post('/v1/me/gates/113/tafsir').set(bearer(other.student.accessToken)).expect(404);
      await t.http().post('/v1/me/gates/113/wrap').set(bearer(other.student.accessToken)).expect(404);
    });

    it('rejects a score out of range and an unknown surah', async () => {
      const room = await atGate('TEACHER');
      await approve(room, room.gate.id, 11).expect(400);
      await t.http().post('/v1/me/gates/115/tafsir').set(bearer(room.student.accessToken)).expect(400);
    });
  });

  describe('skip requests', () => {
    const ask = (token: string, body: object) => t.http().post('/v1/me/skip-requests').set(bearer(token)).send(body);

    it('moves the student past the surah when approved', async () => {
      const room = await classroom();
      await onShortPlan(room.student.id, [113, 114]);
      const { id } = (await ask(room.student.accessToken, { surah: 113, request: 'تجاوز الفلق', reason: 'حفظتها سابقًا' }).expect(201)).body as { id: string };
      await ask(room.student.accessToken, { surah: 113, request: 'مرة أخرى', reason: 'x' }).expect(409);

      const list = (await room.teacher.client.get('/v1/teacher/skip-requests').expect(200)).body as { id: string }[];
      expect(list.map((item) => item.id)).toEqual([id]);

      const other = await classroom();
      await other.teacher.client.post(`/v1/teacher/skip-requests/${id}/approve`).expect(404);

      await room.teacher.client.post(`/v1/teacher/skip-requests/${id}/approve`).expect(204);
      const { summary } = await program(room.student.accessToken);
      expect(summary).toMatchObject({ completedUnits: 1, passedSurahs: 1, status: 'regular' });
      expect(summary.nextLabel).toContain('الناس');
      await room.teacher.client.post(`/v1/teacher/skip-requests/${id}/approve`).expect(404);
    });

    it('leaves the plan alone when rejected', async () => {
      const room = await classroom();
      await onShortPlan(room.student.id, [113, 114]);
      const { id } = (await ask(room.student.accessToken, { surah: 113, request: 'تجاوز', reason: 'x' }).expect(201)).body as { id: string };
      await room.teacher.client.post(`/v1/teacher/skip-requests/${id}/reject`).expect(204);
      expect((await program(room.student.accessToken)).summary.completedUnits).toBe(0);
    });

    it('refuses a surah that is not the current one', async () => {
      const room = await classroom();
      await onShortPlan(room.student.id, [113, 114]);
      const { id } = (await ask(room.student.accessToken, { surah: 114, request: 'تجاوز الناس', reason: 'x' }).expect(201)).body as { id: string };
      expect((await room.teacher.client.post(`/v1/teacher/skip-requests/${id}/approve`).expect(409)).body).toMatchObject({ code: 'not_current_surah' });
    });
  });

  describe('tracks', () => {
    const memorization = { kind: 'MEMORIZATION', name: 'مسار جديد', audience: 'الجميع', durationMonths: 12, memorizationOrder: 'FORWARD', dailyUnit: 'PAGE', wirdDays: [0, 1], consolidationDays: 1 };

    it('starts with the four original tracks, with counts', async () => {
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { code: string; reviewDays: number[]; enrollment: { total: number } }[];
      for (const code of ['advanced', 'steady', 'stabilization', 'correction']) {
        expect(tracks.some((track) => track.code === code)).toBe(true);
      }
      const steady = tracks.find(({ code }) => code === 'steady');
      expect(steady?.reviewDays).toEqual([5, 6]);
      expect(steady?.enrollment.total).toBeGreaterThan(0);
    });

    it.each([
      ['no wird days', { wirdDays: [] }],
      ['a repeated day', { wirdDays: [1, 1] }],
      ['a day that does not exist', { wirdDays: [7] }],
      ['an extra field', { code: 'advanced' }],
      ['a correction field on a memorization track', { focus: 'x' }],
    ])('rejects %s', async (_name, change) => {
      await admin.post('/v1/admin/tracks').send({ ...memorization, ...change }).expect(400);
    });

    it('keeps each kind\'s fields apart', async () => {
      const { id } = (await admin.post('/v1/admin/tracks').send({ kind: 'CORRECTION', name: 'x', audience: 'x', durationMonths: 3, focus: 'x', sessionsPerWeek: 2, application: 'x' }).expect(201)).body as { id: string };
      expect((await admin.patch(`/v1/admin/tracks/${id}`).send({ dailyUnit: 'PAGE' }).expect(400)).body).toMatchObject({ code: 'field_not_for_this_track' });
    });

    describe('a set number of ayahs a day', () => {
      const ayahs = { ...memorization, memorizationOrder: undefined, selectedSurahs: [68, 67], dailyUnit: 'AYAHS', dailyAyahs: 7 };

      it.each([
        ['without a number', { dailyAyahs: undefined }],
        ['more than the longest surah', { dailyAyahs: 287 }],
        ['a number with another unit', { dailyUnit: 'PAGE' }],
      ])('is refused %s', async (_name, change) => {
        await admin.post('/v1/admin/tracks').send({ ...ayahs, ...change }).expect(400);
      });

      it('cuts each chosen surah by that number, in the mushaf order, and follows a change to it', async () => {
        const { id } = (await admin.post('/v1/admin/tracks').send(ayahs).expect(201)).body as { id: string };
        const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; scopeLabel: string; dailyAyahs: number }[];
        // Chosen surahs have no direction.
        expect(tracks.find((track) => track.id === id)).toMatchObject({ scopeLabel: 'الملك، القلم', dailyAyahs: 7 });
        const template = await t.prisma.trackTemplate.findUniqueOrThrow({ where: { id }, select: { surahOrder: true } });
        expect(template.surahOrder).toEqual([67, 68]);

        const student = await newStudent();
        await t.prisma.studentPlan.update({ where: { studentId: student.id }, data: { templateId: id, surahOrder: template.surahOrder, completedUnits: 0 } });
        expect((await program(student.accessToken)).summary.nextLabel).toBe('الملك · 1-7');

        // Either part changes alone, and leaving AYAHS drops the number.
        await admin.patch(`/v1/admin/tracks/${id}`).send({ dailyAyahs: 10 }).expect(204);
        expect((await program(student.accessToken)).summary.nextLabel).toBe('الملك · 1-10');
        await admin.patch(`/v1/admin/tracks/${id}`).send({ dailyUnit: 'SURAH' }).expect(204);
        expect(await t.prisma.trackTemplate.findUniqueOrThrow({ where: { id }, select: { dailyAyahs: true } })).toEqual({ dailyAyahs: null });
        expect((await admin.patch(`/v1/admin/tracks/${id}`).send({ dailyUnit: 'AYAHS' }).expect(400)).body).toMatchObject({ code: 'daily_ayahs_invalid' });
        await admin.patch(`/v1/admin/tracks/${id}`).send({ dailyUnit: 'AYAHS', dailyAyahs: 5 }).expect(204);

        // Counting ayahs suits any scope, the whole Quran included.
        const wholeQuran = { memorizationOrder: 'FORWARD', juzFrom: null, juzTo: null, selectedSurahs: [] };
        await admin.patch(`/v1/admin/tracks/${id}`).send(wholeQuran).expect(204);
      });

      it('counts ayahs over the whole Quran or a juz range', async () => {
        await admin.post('/v1/admin/tracks').send({ ...ayahs, selectedSurahs: [] }).expect(201);
        await admin.post('/v1/admin/tracks').send({ ...ayahs, selectedSurahs: [], juzFrom: 29, juzTo: 30 }).expect(201);
      });
    });

    describe('sessions a day', () => {
      const split = { ...memorization, memorizationOrder: undefined, selectedSurahs: [67], dailyUnit: 'AYAHS', dailyAyahs: 7, dailySessions: 2 };
      type Session = { number: number; fromAyah: number; toAyah: number; title: string; done: boolean };
      const sessionsOf = async (token: string) =>
        ((await t.http().get('/v1/me/dashboard').set('Authorization', `Bearer ${token}`).expect(200)).body as { plan: { sessions: Session[] } }).plan.sessions;

      it.each([
        ['one session', { dailySessions: 1 }],
        ['more than four', { dailySessions: 5 }],
      ])('is refused with %s', async (_name, change) => {
        await admin.post('/v1/admin/tracks').send({ ...split, ...change }).expect(400);
      });

      it('splits the day by ayahs, marks each session on its own, and holds the wird until all are done', async () => {
        const { id } = (await admin.post('/v1/admin/tracks').send(split).expect(201)).body as { id: string };
        const template = await t.prisma.trackTemplate.findUniqueOrThrow({ where: { id }, select: { surahOrder: true } });
        const student = await newStudent();
        await t.prisma.studentPlan.update({ where: { studentId: student.id }, data: { templateId: id, surahOrder: template.surahOrder, completedUnits: 0 } });

        // Al-Mulk 1-7, as 1-4 and 5-7.
        expect(await sessionsOf(student.accessToken)).toMatchObject([
          { number: 1, fromAyah: 1, toAyah: 4, title: 'الفترة الأولى', done: false },
          { number: 2, fromAyah: 5, toAyah: 7, title: 'الفترة الثانية', done: false },
        ]);
        const session = (number: number, done: boolean) =>
          t.http().post(`/v1/me/wird/sessions/${number}`).set('Authorization', `Bearer ${student.accessToken}`).send({ done });
        await session(2, true).expect(204);
        expect((await sessionsOf(student.accessToken)).map(({ done }) => done)).toEqual([false, true]);
        await session(3, true).expect(400);

        // Every step done, but the first session isn't.
        await t.prisma.wirdProgress.update({
          where: { planId_unitIndex: { planId: (await t.prisma.studentPlan.findUniqueOrThrow({ where: { studentId: student.id } })).id, unitIndex: 0 } },
          data: { repeatCount: 999, reviewCount: 999, listenCount: 999, doneSteps: Array.from({ length: 50 }, (_, index) => index) },
        });
        const complete = () => t.http().post('/v1/me/wird/complete').set('Authorization', `Bearer ${student.accessToken}`);
        expect((await complete().expect(409)).body).toMatchObject({ code: 'wird_sessions_incomplete' });
        await session(1, true).expect(204);
        await complete().expect(204);

        // Turning the option off keeps the day whole.
        await admin.patch(`/v1/admin/tracks/${id}`).send({ dailySessions: null }).expect(204);
        expect(await sessionsOf(student.accessToken)).toEqual([]);
      });
    });

    it('registers a student on a track the administrator added, and refuses a correction track', async () => {
      const dto = { name: 'مسار مضاف', audience: 'الجميع', durationMonths: 12 };
      const added = (await admin.post('/v1/admin/tracks').send({ kind: 'MEMORIZATION', ...dto, dailyUnit: 'PAGE', wirdDays: [0, 1], consolidationDays: 1 }).expect(201)).body as { id: string };
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; code: string }[];
      const { code } = tracks.find(({ id }) => id === added.id)!;

      const register = async (trackId: string) => {
        const phone = newPhone();
        await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'register' }).expect(202);
        return t
          .http()
          .post('/v1/auth/otp/verify')
          .send({ phone, code: t.codeFor(phone), registration: { fullName: 'نورة علي أحمد', country: 'مصر', ageBand: '20', section: 'women', trackId, trackStart: null, pledgesAccepted: true } });
      };

      const registered = await register(code);
      expect(registered.status).toBeLessThan(300);
      const profile = (await t.http().get('/v1/me').set(bearer((registered.body as { accessToken: string }).accessToken)).expect(200)).body as { trackId: string };
      expect(profile.trackId).toBe(code);

      expect((await register('correction')).status).toBe(409);
      expect((await register('no-such-track')).status).toBe(409);
    });

    it('closes registration on a stopped track, and keeps those already on it', async () => {
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; code: string }[];
      const advanced = tracks.find(({ code }) => code === 'advanced')!;
      await admin.patch(`/v1/admin/tracks/${advanced.id}`).send({ active: false }).expect(204);
      try {
        const phone = newPhone();
        await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'register' }).expect(202);
        const { body } = await t
          .http()
          .post('/v1/auth/otp/verify')
          .send({ phone, code: t.codeFor(phone), registration: { fullName: 'نورة علي أحمد', country: 'مصر', ageBand: '20', section: 'women', trackId: 'advanced', trackStart: null, pledgesAccepted: true } })
          .expect(409);
        expect(body).toMatchObject({ code: 'track_closed' });
      } finally {
        await admin.patch(`/v1/admin/tracks/${advanced.id}`).send({ active: true }).expect(204);
      }
    });

    it('applies a new unit size to students in progress, keeping what they memorized', async () => {
      const room = await classroom();
      const templateId = await onShortPlan(room.student.id, [113, 114]);
      await admin.patch(`/v1/admin/tracks/${templateId}`).send({ dailyUnit: 'PAGE' }).expect(204);
      await admin.patch(`/v1/admin/tracks/${templateId}`).send({ dailyUnit: 'SURAH' }).expect(204);
      await complete(room.student.accessToken).expect(204);
      await admin.patch(`/v1/admin/tracks/${templateId}`).send({ dailyUnit: 'PAGE' }).expect(204);
      const plan = await t.prisma.studentPlan.findUniqueOrThrow({ where: { studentId: room.student.id }, include: { logs: true } });
      // Surah 113 fills its page's first part, so the finished surah counts as its one page.
      expect(plan.completedUnits).toBe(1);
      expect(plan.logs.map(({ unitIndex }) => unitIndex)).toEqual([0]);
    });

    it('lets a supervisor set a circle\'s track only while allowed, and only in scope', async () => {
      const room = await classroom();
      const { canEdit } = (await supervisorA.get('/v1/supervisor/templates').expect(200)).body as { canEdit: boolean };
      expect(canEdit).toBe(true);
      const trackId = await trackIdOf(t);
      await supervisorA.patch(`/v1/supervisor/circles/${room.circleId}/track`).send({ trackId }).expect(204);
      await supervisorB.patch(`/v1/supervisor/circles/${room.circleId}/track`).send({ trackId }).expect(404);

      await admin.put('/v1/admin/settings/permissions').send({ openRecord: true, editTemplates: false }).expect(204);
      try {
        expect((await supervisorA.patch(`/v1/supervisor/circles/${room.circleId}/track`).send({ trackId }).expect(403)).body).toMatchObject({ code: 'templates_locked' });
      } finally {
        await admin.put('/v1/admin/settings/permissions').send({ openRecord: true, editTemplates: true }).expect(204);
      }
    });
  });

  describe('administrators only', () => {
    it.each([
      ['get', '/v1/admin/tracks'],
      ['get', '/v1/admin/overview'],
      ['get', '/v1/admin/settings'],
      ['get', '/v1/admin/motivation'],
      ['get', '/v1/admin/quran-content'],
      ['get', '/v1/admin/broadcasts'],
      ['get', '/v1/admin/reports/program'],
      ['post', '/v1/admin/translations'],
      ['put', '/v1/admin/settings/features'],
    ] as const)('keeps %s %s from a supervisor', async (method, path) => {
      await supervisorA[method](path).expect(403);
    });

    it('is closed to the signed-out, students, and bad origins', async () => {
      await t.http().get('/v1/admin/tracks').expect(401);
      const student = await newStudent();
      await t.http().get('/v1/admin/tracks').set(bearer(student.accessToken)).expect(401);
      await request(t.app.getHttpServer()).put('/v1/admin/settings/features').send({}).expect(403);
    });
  });

  describe('settings', () => {
    it('reach the app with no account, and reject a wrong shape', async () => {
      await admin.put('/v1/admin/settings/features').send({ englishEnabled: false, smartRecitation: true, offlineRecitation: true, encouragementEnabled: true }).expect(204);
      try {
        const { body } = await t.http().get('/v1/app-config').expect(200);
        expect(body).toMatchObject({ languages: { ar: true, en: false }, smartRecitation: { enabled: true } });
      } finally {
        await admin.put('/v1/admin/settings/features').send({ englishEnabled: true, smartRecitation: true, offlineRecitation: true, encouragementEnabled: true }).expect(204);
      }
      await admin.put('/v1/admin/settings/features').send({ englishEnabled: 'yes' }).expect(400);
      await admin.put('/v1/admin/gate-rules/conditions').send({ tafsir: true, wrap: true, wrapCount: 0, exam: true, passScore: 7, examDelayDays: 14 }).expect(400);
    });

    it('turns smart recitation offline off along with smart recitation', async () => {
      await admin.put('/v1/admin/settings/features').send({ englishEnabled: true, smartRecitation: false, offlineRecitation: true, encouragementEnabled: true }).expect(204);
      try {
        expect((await t.http().get('/v1/app-config').expect(200)).body).toMatchObject({ smartRecitation: { enabled: false, offline: false } });
      } finally {
        await admin.put('/v1/admin/settings/features').send({ englishEnabled: true, smartRecitation: true, offlineRecitation: true, encouragementEnabled: true }).expect(204);
      }
    });

    it('records new pledge wording as a new version, and new students against it', async () => {
      const before = ((await admin.get('/v1/admin/settings').expect(200)).body as { pledges: { version: number; items: string[] } }).pledges;
      await admin.put('/v1/admin/settings/pledges').send({ items: before.items.slice(0, 2) }).expect(400);
      await admin.put('/v1/admin/settings/pledges').send({ items: before.items.map((item) => `${item}.`) }).expect(204);
      const student = await newStudent();
      const consents = await t.prisma.userConsent.findMany({ where: { userId: student.id } });
      expect(consents.every(({ version }) => version === String(before.version + 1))).toBe(true);
    });

    it('adds an info page that can then be edited', async () => {
      const { slug } = (await admin.post('/v1/admin/settings/pages').send({ title: 'صفحة', body: 'نص' }).expect(201)).body as { slug: string };
      await admin.patch(`/v1/admin/settings/pages/${slug}`).send({ title: 'صفحة معدلة', body: 'نص' }).expect(204);
      const { pages } = (await t.http().get('/v1/app-config').expect(200)).body as { pages: { slug: string; title: string }[] };
      expect(pages.find((page) => page.slug === slug)?.title).toBe('صفحة معدلة');
    });

    it('edits info pages, and only ones that exist', async () => {
      await admin.patch('/v1/admin/settings/pages/about').send({ title: 'عن قمم', body: 'نص' }).expect(204);
      await admin.patch('/v1/admin/settings/pages/nope').send({ title: 'x', body: 'x' }).expect(404);
      await admin.patch('/v1/admin/settings/pages/ABOUT').send({ title: 'x', body: 'x' }).expect(400);
      const { pages } = (await t.http().get('/v1/app-config').expect(200)).body as { pages: { slug: string; title: string }[] };
      expect(pages.find(({ slug }) => slug === 'about')?.title).toBe('عن قمم');
    });

    it('closes the old record to a new teacher when the permission is off', async () => {
      const from = await classroom();
      const to = await classroom();
      await from.teacher.client.post('/v1/teacher/recitations').send({ studentId: from.student.id, surah: 18, fromAyah: 1, toAyah: 2, ...MASTERED }).expect(201);
      const { id } = (await supervisorA.post('/v1/supervisor/transfers').send({ studentId: from.student.id, toCircleId: to.circleId }).expect(201)).body as { id: string };
      await admin.post(`/v1/admin/transfers/${id}/approve`).expect(204);
      await to.teacher.client.post(`/v1/teacher/transfers/${id}/accept`).expect(204);

      const evaluations = async () =>
        ((await to.teacher.client.get(`/v1/teacher/students/${from.student.id}`).expect(200)).body as { evaluations: object[] }).evaluations;
      expect(await evaluations()).toHaveLength(1);
      await admin.put('/v1/admin/settings/permissions').send({ openRecord: false, editTemplates: true }).expect(204);
      try {
        expect(await evaluations()).toEqual([]);
      } finally {
        await admin.put('/v1/admin/settings/permissions').send({ openRecord: true, editTemplates: true }).expect(204);
      }
    });
  });

  describe('translations', () => {
    const fullVerses = () => SURAHS.flatMap(({ number, ayahCount }) => Array.from({ length: ayahCount }, (_, i) => ({ surah: number, ayah: i + 1, text: `v ${number}:${i + 1}` })));
    const upload = (client: Agent, content: string | Buffer, filename: string, language = 'English') =>
      client.post('/v1/admin/translations').field('language', language).field('source', 'Test').attach('file', Buffer.from(content), filename);

    it('takes a complete file for review, previews it, and approves one per language', async () => {
      const first = (await upload(admin, JSON.stringify(fullVerses()), 'a.json').expect(201)).body as { id: string; verses: number };
      expect(first.verses).toBe(6236);
      expect((await admin.get(`/v1/admin/translations/${first.id}/preview?surah=18&ayah=10`).expect(200)).body).toMatchObject({ text: 'v 18:10', surahName: 'الكهف' });
      await admin.get(`/v1/admin/translations/${first.id}/preview?surah=18&ayah=999`).expect(404);
      await admin.post(`/v1/admin/translations/${first.id}/approve`).expect(204);
      await admin.post(`/v1/admin/translations/${first.id}/approve`).expect(404);

      const csv = `surah,ayah,text\n${fullVerses().map(({ surah, ayah, text }) => `${surah},${ayah},"${text}"`).join('\n')}`;
      const second = (await upload(admin, csv, 'b.csv').expect(201)).body as { id: string };
      await admin.post(`/v1/admin/translations/${second.id}/approve`).expect(204);

      const { translations } = (await admin.get('/v1/admin/quran-content').expect(200)).body as { translations: { id: string; status: string }[] };
      expect(translations.find(({ id }) => id === first.id)?.status).toBe('REJECTED');
      expect(translations.find(({ id }) => id === second.id)?.status).toBe('APPROVED');
    }, 180_000);

    it('removes a rejected file\'s text', async () => {
      const { id } = (await upload(admin, JSON.stringify(fullVerses()), 'c.json', 'French').expect(201)).body as { id: string };
      await admin.post(`/v1/admin/translations/${id}/reject`).expect(204);
      expect(await t.prisma.translationVerse.count({ where: { translationId: id } })).toBe(0);
    }, 120_000);

    it.each([
      ['a missing verse', () => JSON.stringify(fullVerses().slice(1)), 'x.json', 'incomplete_translation'],
      ['a duplicate verse', () => JSON.stringify([fullVerses()[0], ...fullVerses()]), 'x.json', 'invalid_ayah_reference'],
      ['an ayah that does not exist', () => JSON.stringify([...fullVerses().slice(1), { surah: 1, ayah: 8, text: 'x' }]), 'x.json', 'invalid_ayah_reference'],
      ['markup in the text', () => JSON.stringify(fullVerses().map((v, i) => (i === 5 ? { ...v, text: '<script>alert(1)</script>' } : v))), 'x.json', 'markup_not_allowed'],
      ['broken JSON', () => '{', 'x.json', 'unreadable_file'],
      ['the wrong shape', () => JSON.stringify({ a: 1 }), 'x.json', 'invalid_translation_rows'],
      ['a disguised file type', () => 'MZ', 'x.exe', 'unsupported_file_type'],
    ])('refuses %s and saves nothing', async (_name, content, filename, code) => {
      const before = await t.prisma.translation.count();
      expect((await upload(admin, content(), filename).expect(400)).body).toMatchObject({ code });
      expect(await t.prisma.translation.count()).toBe(before);
    }, 60_000);

    it('refuses a file over the limit, and a request with no file', async () => {
      await upload(admin, Buffer.alloc(21 * 1024 * 1024, 'a'), 'big.json').expect(413);
      await admin.post('/v1/admin/translations').field('language', 'x').field('source', 'y').expect(400);
    }, 60_000);

    it('stores a safe file name, whatever is sent', async () => {
      const { id } = (await upload(admin, JSON.stringify(fullVerses()), '../../etc/passwd.json', 'German').expect(201)).body as { id: string };
      const row = await t.prisma.translation.findUniqueOrThrow({ where: { id } });
      expect(row.fileName).toBe('passwd.json');
    }, 120_000);

    it('checks language files', async () => {
      const send = (content: string, name = 'en.json') => admin.post('/v1/admin/settings/languages/en').attach('file', Buffer.from(content), name);
      expect((await send(JSON.stringify({ hello: 'Hello' })).expect(201)).body).toEqual({ keys: 1 });
      await send(JSON.stringify({ nested: { a: 'b' } })).expect(400);
      await send(JSON.stringify(['a'])).expect(400);
      await send(JSON.stringify({ a: '<img src=x>' })).expect(400);
      await send('x', 'en.txt').expect(400);
      await admin.post('/v1/admin/settings/languages/fr').attach('file', Buffer.from('{}'), 'fr.json').expect(400);
    });
  });

  describe('tadabbur content', () => {
    const content = { lessonType: 'مباشر', sheikh: 'الشيخ', schedule: 'كل خميس', link: 'https://meet.example/kahf', journaling: true, published: true, tasks: [{ title: 'بر الوالدين', note: 'موقف عملي' }] };

    it('lists all 114 surahs with their status', async () => {
      await admin.put('/v1/admin/tadabbur/18').send(content).expect(200);
      await admin.put('/v1/admin/tadabbur/19').send({ ...content, published: false, link: null, tasks: [] }).expect(200);
      const list = (await admin.get('/v1/admin/tadabbur').expect(200)).body as { surah: number; status: string }[];
      expect(list).toHaveLength(114);
      expect(list.find(({ surah }) => surah === 18)?.status).toBe('complete');
      expect(list.find(({ surah }) => surah === 19)?.status).toBe('draft');
      expect(list.find(({ surah }) => surah === 20)?.status).toBe('empty');
    });

    it.each([
      ['publishing with no tasks', { tasks: [] }],
      ['publishing with no link', { link: null }],
      ['a link that is not https', { link: 'http://meet.example/x' }],
      ['a script link', { link: 'javascript:alert(1)' }],
    ])('rejects %s', async (_name, change) => {
      await admin.put('/v1/admin/tadabbur/21').send({ ...content, ...change }).expect(400);
    });

    it('keeps a task\'s completions when it is edited, and refuses another surah\'s task', async () => {
      const saved = (await admin.put('/v1/admin/tadabbur/22').send(content).expect(200)).body as { content: { tasks: { id: string }[] } };
      const taskId = saved.content.tasks[0].id;
      const student = await newStudent();
      await t.http().post(`/v1/me/practical/${taskId}`).set(bearer(student.accessToken)).expect(204);

      await admin.put('/v1/admin/tadabbur/22').send({ ...content, tasks: [{ id: taskId, title: 'معدلة', note: 'ملاحظة' }] }).expect(200);
      expect(await t.prisma.practicalCompletion.count({ where: { taskId } })).toBe(1);

      await admin.put('/v1/admin/tadabbur/23').send({ ...content, tasks: [{ id: taskId, title: 'سرقة', note: 'x' }] }).expect(404);
      expect((await t.prisma.tadabburTask.findUniqueOrThrow({ where: { id: taskId } })).surah).toBe(22);
    });

    it('hides unpublished content from students', async () => {
      await admin.put('/v1/admin/tadabbur/24').send({ ...content, published: false }).expect(200);
      const student = await newStudent();
      const { text } = await t.http().get('/v1/me/tadabbur/24').set(bearer(student.accessToken)).expect(200);
      expect(text).toBe('');
    });
  });

  describe('gaps from the map', () => {
    const setAdmission = (required: boolean) => admin.put('/v1/admin/settings/admission').send({ required }).expect(204);

    it('holds a new student at the admission test until accepted', async () => {
      const room = await classroom();
      await setAdmission(true);
      try {
        const student = await newStudent();
        const me = (await t.http().get('/v1/me').set(bearer(student.accessToken)).expect(200)).body as { admission: { status: string } };
        expect(me.admission.status).toBe('pending');
        await t.http().get('/v1/me/dashboard').set(bearer(student.accessToken)).expect(200);
        expect(await t.prisma.studentPlan.count({ where: { studentId: student.id } })).toBe(0);

        const list = (await supervisorA.get('/v1/admissions').expect(200)).body as { scheduling: string; applicants: { id: string; phone: string }[] };
        expect(list.scheduling).toBe('SUPERVISOR');
        expect(list.applicants.some(({ id }) => id === student.id)).toBe(true);
        const { body: refused } = await supervisorA.post(`/v1/supervisor/circles/${room.circleId}/students`).send({ studentId: student.id }).expect(409);
        expect(refused).toMatchObject({ code: 'student_not_admitted' });

        await supervisorA.post(`/v1/admissions/${student.id}/decision`).send({ accepted: false, score: 4, note: 'أعيدي بعد شهر' }).expect(204);
        const rejected = (await t.http().get('/v1/me').set(bearer(student.accessToken)).expect(200)).body as { admission: { status: string; note: string } };
        expect(rejected.admission).toEqual({ status: 'rejected', note: 'أعيدي بعد شهر' });
        expect(await t.prisma.studentPlan.count({ where: { studentId: student.id } })).toBe(0);

        await admin.post(`/v1/admissions/${student.id}/decision`).send({ accepted: true, score: 8, note: null }).expect(204);
        expect(await t.prisma.studentPlan.count({ where: { studentId: student.id } })).toBe(1);
        await admin.post(`/v1/admissions/${student.id}/decision`).send({ accepted: false, score: 1, note: null }).expect(404);
        const teacher = await newStaff('TEACHER', scopeA);
        await teacher.client.get('/v1/admissions').expect(403);
      } finally {
        await setAdmission(false);
      }
    });

    it('chooses the track after the admission test: by the tester, or by the student once accepted', async () => {
      await setAdmission(true);
      try {
        const signUp = async (section: 'women' | 'men') => {
          const phone = newPhone();
          await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'register' }).expect(202);
          const { body } = await t
            .http()
            .post('/v1/auth/otp/verify')
            .send({ phone, code: t.codeFor(phone), registration: { fullName: 'هند علي أحمد', country: 'مصر', ageBand: '20', section, pledgesAccepted: true } })
            .expect(200);
          const token = (body as { accessToken: string }).accessToken;
          const { id } = (await t.http().get('/v1/me').set(bearer(token)).expect(200)).body as { id: string };
          return { id, token };
        };
        const profile = async (token: string) =>
          (await t.http().get('/v1/me').set(bearer(token)).expect(200)).body as { trackId: string | null; trackStart: string | null };

        // No track at sign-up, and none can be chosen before the test is passed.
        const chooser = await signUp('women');
        expect((await profile(chooser.token)).trackId).toBeNull();
        const early = await t.http().patch('/v1/me').set(bearer(chooser.token)).send({ track: { trackId: 'steady', trackStart: null } }).expect(409);
        expect(early.body).toMatchObject({ code: 'admission_pending' });

        // Accepted with the track left open: no plan until she chooses one.
        await supervisorA.post(`/v1/admissions/${chooser.id}/decision`).send({ accepted: true, score: 8, note: null }).expect(204);
        expect(await t.prisma.studentPlan.count({ where: { studentId: chooser.id } })).toBe(0);
        await t.http().patch('/v1/me').set(bearer(chooser.token)).send({ track: { trackId: 'steady', trackStart: null } }).expect(200);
        expect((await profile(chooser.token)).trackId).toBe('steady');
        expect(await t.prisma.studentPlan.count({ where: { studentId: chooser.id } })).toBe(1);

        // The tester chooses the track, and the plan begins on it.
        const placed = await signUp('women');
        const tracks = (await supervisorA.get('/v1/admissions/tracks').expect(200)).body as { id: string; code: string; forMen: boolean }[];
        const stabilization = tracks.find(({ code }) => code === 'stabilization')!;
        await supervisorA.post(`/v1/admissions/${placed.id}/decision`).send({ accepted: true, score: 9, note: null, trackId: stabilization.id, trackStart: 'FATIHA' }).expect(204);
        expect(await profile(placed.token)).toMatchObject({ trackId: 'stabilization', trackStart: 'fatiha' });
        expect(await t.prisma.studentPlan.count({ where: { studentId: placed.id } })).toBe(1);

        // Online recitation is for the women's section only, so the tester can't put a man on such a track.
        const man = await signUp('men');
        expect(stabilization.forMen).toBe(false);
        const refused = await supervisorA.post(`/v1/admissions/${man.id}/decision`).send({ accepted: true, score: 9, note: null, trackId: stabilization.id }).expect(409);
        expect(refused.body).toMatchObject({ code: 'track_not_for_section' });
        expect((await profile(man.token)).trackId).toBeNull();
      } finally {
        await setAdmission(false);
      }
    });

    it('runs the admission test in its own room: assigned, booked, started, and decided by the teacher', async () => {
      const setScheduling = (scheduling: string) =>
        admin.put('/v1/admin/settings/admission').send({ required: true, scheduling }).expect(204);
      await setScheduling('STUDENT');
      try {
        const student = await newStudent();
        const other = await newStudent();
        const teacher = await newStaff('TEACHER', scopeA);
        const outsider = await newStaff('TEACHER', scopeB);
        const me = (path: string) => t.http().get(path).set(bearer(student.accessToken));

        const teachers = (await supervisorA.get('/v1/admissions/teachers').expect(200)).body as { id: string }[];
        expect(teachers.some(({ id }) => id === teacher.id)).toBe(true);
        expect(teachers.some(({ id }) => id === outsider.id)).toBe(false);
        await supervisorA.put(`/v1/admissions/${student.id}/test`).send({ teacherId: outsider.id, scheduledAt: null }).expect(404);

        // With STUDENT scheduling, the supervisor assigns only the teacher.
        const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
        await supervisorA.put(`/v1/admissions/${student.id}/test`).send({ teacherId: teacher.id, scheduledAt: later }).expect(409);
        const { body: assigned } = await supervisorA.put(`/v1/admissions/${student.id}/test`).send({ teacherId: teacher.id, scheduledAt: null }).expect(200);
        await supervisorA.put(`/v1/admissions/${other.id}/test`).send({ teacherId: teacher.id, scheduledAt: null }).expect(200);
        const testId = (assigned as { id: string }).id;

        const { body: slot } = await teacher.client.post('/v1/teacher/admission/slots').send({ startsAt: later }).expect(201);
        const slotId = (slot as { id: string }).id;
        await teacher.client.post('/v1/teacher/admission/slots').send({ startsAt: later }).expect(409);

        const view = (await me('/v1/me/admission').expect(200)).body as { canBook: boolean; slots: { id: string }[] };
        expect(view.canBook).toBe(true);
        expect(view.slots.map(({ id }) => id)).toEqual([slotId]);

        await t.http().post('/v1/me/admission/book').set(bearer(student.accessToken)).send({ slotId }).expect(200);
        // The same time can't go to two students, and a booked time can't be removed.
        await t.http().post('/v1/me/admission/book').set(bearer(other.accessToken)).send({ slotId }).expect(409);
        await teacher.client.delete(`/v1/teacher/admission/slots/${slotId}`).expect(409);
        const booked = (await me('/v1/me/admission').expect(200)).body as { canBook: boolean; test: { scheduledAt: string } };
        expect(booked.canBook).toBe(false);
        expect(new Date(booked.test.scheduledAt).toISOString()).toBe(later);

        // No room before the teacher starts, and only the assigned teacher's own room.
        await t.http().post(`/v1/me/admission/tests/${testId}/voice-ticket`).set(bearer(student.accessToken)).expect(409);
        await outsider.client.post(`/v1/teacher/admission/tests/${testId}/start`).expect(404);
        await teacher.client.post(`/v1/teacher/admission/tests/${testId}/start`).expect(204);
        await t.http().post(`/v1/me/admission/tests/${testId}/voice-ticket`).set(bearer(student.accessToken)).expect(200);
        await t.http().post(`/v1/me/admission/tests/${testId}/voice-ticket`).set(bearer(other.accessToken)).expect(404);
        await teacher.client.post(`/v1/teacher/admission/tests/${testId}/voice-ticket`).expect(200);
        await supervisorA.put(`/v1/admissions/${student.id}/test`).send({ teacherId: teacher.id, scheduledAt: null }).expect(409);

        await teacher.client.post(`/v1/teacher/admission/tests/${testId}/decision`).send({ accepted: true, score: 9, note: null }).expect(204);
        expect(await t.prisma.studentPlan.count({ where: { studentId: student.id } })).toBe(1);
        expect((await t.prisma.admissionTest.findUniqueOrThrow({ where: { id: testId } })).status).toBe('COMPLETED');
        await t.http().post(`/v1/me/admission/tests/${testId}/voice-ticket`).set(bearer(student.accessToken)).expect(409);

        // A supervisor's decision cancels a test not yet held, and frees nothing it didn't book.
        await supervisorA.post(`/v1/admissions/${other.id}/decision`).send({ accepted: false, score: null, note: null }).expect(204);
        const closed = await t.prisma.admissionTest.findFirstOrThrow({ where: { studentId: other.id } });
        expect(closed.status).toBe('CANCELLED');
      } finally {
        await admin.put('/v1/admin/settings/admission').send({ required: false }).expect(204);
      }
    });

    it('sends reminders at the student\'s own time, in their own zone', async () => {
      const student = await newStudent();
      await t.http().patch('/v1/me').set(bearer(student.accessToken)).send({ preferences: { timeZone: 'America/New_York', reminderMinutes: 18 * 60 } }).expect(200);
      await t.http().patch('/v1/me').set(bearer(student.accessToken)).send({ preferences: { timeZone: 'Not/AZone' } }).expect(400);
      await t.http().patch('/v1/me').set(bearer(student.accessToken)).send({ preferences: { reminderMinutes: 1440 } }).expect(400);
      
      
      const service = t.app.get(NotificationsService);
      const count = () => t.prisma.notification.count({ where: { userId: student.id, type: { in: ['DAILY_WIRD', 'WEEKLY_REVIEW'] } } });

      // 14:00 in Riyadh on a Wednesday is 06:00 in New York: past Riyadh's evening rule, before this student's time.
      await service.sendWirdReminders(new Date('2026-11-11T11:00:00Z'));
      await service.sendReviewReminders(new Date('2026-11-11T11:00:00Z'));
      expect(await count()).toBe(0);
      // 18:30 in New York.
      await service.sendWirdReminders(new Date('2026-11-11T23:30:00Z'));
      await service.sendReviewReminders(new Date('2026-11-11T23:30:00Z'));
      await service.sendWirdReminders(new Date('2026-11-11T23:35:00Z'));
      await service.sendReviewReminders(new Date('2026-11-11T23:35:00Z'));
      expect(await count()).toBe(1);
    });

    it('sends each absence warning once, one higher level at a time, and starts over after attending', async () => {
      const room = await classroom();
      const service = t.app.get(NotificationsService);
      const warnings = () => t.prisma.notification.findMany({ where: { userId: room.student.id, dedupeKey: { startsWith: 'absence:' } }, orderBy: { createdAt: 'asc' }, select: { title: true } });
      const record = async (attendance: 'ABSENT' | 'PRESENT', daysAgo: number) => {
        await t.prisma.evaluation.create({ data: { studentId: room.student.id, title: 'حضور', attendance, createdAt: new Date(Date.now() - daysAgo * 86_400_000) } });
        await service.checkAbsence(room.student.id);
      };
      await record('ABSENT', 3);
      expect(await warnings()).toHaveLength(0);
      await record('ABSENT', 2);
      await service.checkAbsence(room.student.id);
      expect(await warnings()).toHaveLength(1);
      await record('ABSENT', 1);
      expect((await warnings()).map(({ title }) => title)).toEqual(['بنيتنا، افتقدنا حضورك', 'طالت غيبتك']);
      await t.prisma.evaluation.deleteMany({ where: { studentId: room.student.id } });
      await record('PRESENT', 0);
      expect(await t.prisma.absenceWarning.count({ where: { studentId: room.student.id, resolvedAt: null } })).toBe(0);
    });

    it('schedules recited segments further out with each review', async () => {
      const room = await classroom();
      const token = room.student.accessToken;
      const recite = (fromAyah: number, toAyah: number, segmentStatus: string) =>
        room.teacher.client.post('/v1/teacher/recitations').send({ studentId: room.student.id, surah: 2, fromAyah, toAyah, score: 7, segmentStatus, attendance: 'PRESENT' }).expect(201);
      await recite(1, 5, 'NEEDS_REVIEW');
      await recite(6, 10, 'MASTERED');
      type Segment = { id: string; level: string; daysLeft: number; reviewedToday: boolean };
      const schedule = async () => (await t.http().get('/v1/me/review-schedule').set(bearer(token)).expect(200)).body as { today: Segment[]; upcoming: Segment[] };

      const first = await schedule();
      expect(first.upcoming.map(({ level, daysLeft }) => [level, daysLeft])).toEqual([['needs_review', 1], ['mastered', 7]]);

      const segment = first.upcoming[0];
      await t.http().post(`/v1/me/review-schedule/${segment.id}/done`).set(bearer(token)).expect(204);
      await t.http().post(`/v1/me/review-schedule/${segment.id}/done`).set(bearer(token)).expect(204);
      const second = await schedule();
      const moved = second.upcoming.find(({ id }) => id === segment.id)!;
      expect(moved).toMatchObject({ daysLeft: 3, reviewedToday: true });

      const other = await newStudent();
      await t.http().post(`/v1/me/review-schedule/${segment.id}/done`).set(bearer(other.accessToken)).expect(404);
    });

    it('fills the teacher\'s file, records stage exams, and tells the teacher what students did', async () => {
      const room = await classroom();
      const teacher = room.teacher.client;
      const { id: taskId } = (await teacher.post('/v1/teacher/tasks').send({ title: 'مهمة', studentId: room.student.id, recurrence: 'DAILY' }).expect(201)).body as { id: string };
      await t.http().post(`/v1/me/tasks/${taskId}/complete`).set(bearer(room.student.accessToken)).expect(204);
      await t.http().post(`/v1/me/tasks/${taskId}/complete`).set(bearer(room.student.accessToken)).expect(204);

      const inbox = (await teacher.get('/v1/staff/notifications').expect(200)).body as { unread: number; items: { id: string; title: string; opens: string | null }[] };
      expect(inbox.unread).toBe(1);
      expect(inbox.items[0]).toMatchObject({ title: 'نُفّذت مهمة', opens: 'tasks' });
      await teacher.post(`/v1/staff/notifications/${inbox.items[0].id}/read`).expect(204);
      expect(((await teacher.get('/v1/staff/notifications').expect(200)).body as { unread: number }).unread).toBe(0);

      await teacher.post('/v1/teacher/stage-exams').send({ studentId: room.student.id, stage: 1, score: 9 }).expect(201);
      const exams = (await teacher.get('/v1/teacher/stage-exams').expect(200)).body as { items: { passed: boolean; student: { name: string } }[] };
      expect(exams.items[0].passed).toBe(true);
      expect(await t.prisma.notification.count({ where: { userId: room.student.id, title: 'نتيجة الاختبار المرحلي' } })).toBe(1);

      await teacher.post('/v1/teacher/recitations').send({ studentId: room.student.id, surah: 2, fromAyah: 1, toAyah: 3, score: 8, segmentStatus: 'MASTERED', attendance: 'PRESENT' }).expect(201);
      const record = (await teacher.get(`/v1/teacher/students/${room.student.id}/record`).expect(200)).body as {
        recitations: object[];
        stageExams: object[];
        attendance: object[];
        tasks: { done: boolean }[];
      };
      expect(record.recitations).toHaveLength(1);
      expect(record.stageExams).toHaveLength(1);
      expect(record.attendance).toHaveLength(1);
      expect(record.tasks[0].done).toBe(true);

      const stranger = await newStaff('TEACHER', scopeA);
      await stranger.client.get(`/v1/teacher/students/${room.student.id}/record`).expect(404);
    });

    it('shows a teacher the announcements that reach them, and no others', async () => {
      const room = await classroom();
      const title = `إعلان ${randomId().slice(0, 6)}`;
      await supervisorA.post('/v1/supervisor/announcements').send({ audience: 'CIRCLE', circleId: room.circleId, title, body: 'نص' }).expect(201);
      const seen = (await room.teacher.client.get('/v1/teacher/announcements').expect(200)).body as { title: string }[];
      expect(seen.some((item) => item.title === title)).toBe(true);
      const other = await newStaff('TEACHER', scopeB);
      const hidden = (await other.client.get('/v1/teacher/announcements').expect(200)).body as { title: string }[];
      expect(hidden.some((item) => item.title === title)).toBe(false);
    });

    it('recovers a password by mail, without revealing who has an account', async () => {
      const staff = await newStaff('TEACHER', scopeA);
      const before = t.mails.length;
      await agent().post('/v1/staff/auth/password/forgot').send({ email: 'nobody-here@qimam.test' }).expect(204);
      await agent().post('/v1/staff/auth/password/forgot').send({ email: staff.email }).expect(204);
      await vi.waitFor(() => expect(t.mails.length).toBe(before + 1));
      expect(t.mails.at(-1)?.to).toBe(staff.email);
      const token = /token=([A-Za-z0-9_-]{43})/.exec(t.mails.at(-1)?.text ?? '')?.[1];
      expect(token).toBeTruthy();

      const fresh = 'Another-Strong-Pass-5512';
      await agent().post('/v1/staff/auth/password/set').send({ token, password: fresh }).expect(204);
      await agent().post('/v1/staff/auth/password/set').send({ token, password: fresh }).expect(400);
      await agent().post('/v1/staff/auth/login').send({ identifier: staff.email, password: PASSWORD }).expect(401);
      await agent().post('/v1/staff/auth/login').send({ identifier: staff.email, password: fresh }).expect(200);
    });

    it('serves uploaded interface files and only approved translations', async () => {
      await admin.post('/v1/admin/settings/languages/en').attach('file', Buffer.from(JSON.stringify({ 'حسابي': 'My account' })), 'en.json').expect(201);
      const { body: config } = await t.http().get('/v1/app-config').expect(200);
      expect((config as { languagePacks: { code: string }[] }).languagePacks.some(({ code }) => code === 'en')).toBe(true);
      const { body: pack } = await t.http().get('/v1/language-packs/en').expect(200);
      expect((pack as { content: Record<string, string> }).content['حسابي']).toBe('My account');
      await t.http().get('/v1/language-packs/fr').expect(400);

      const unknown = randomId();
      await t.http().get(`/v1/translations/${unknown}/surahs/1`).expect(404);
    });
  });

  describe('sections', () => {
    it('keeps the men\'s and the women\'s sections apart, and speaks to each in its own wording', async () => {
      const man = await newStudent('men');
      const me = (await t.http().get('/v1/me').set(bearer(man.accessToken)).expect(200)).body as { section: string; trackId: string | null };
      expect(me).toMatchObject({ section: 'men', trackId: null });
      await t.http().post('/v1/auth/otp/verify').send({ phone: newPhone(), code: '000000', registration: { fullName: 'سعد علي أحمد', country: 'مصر', ageBand: '20', trackId: 'steady', trackStart: null, pledgesAccepted: true } }).expect(400);

      // Online recitation is for the women's section only: a track that uses it is closed to men, and hidden from them.
      const recorded = await recordedTrack();
      const live = await t.http().patch('/v1/me').set(bearer(man.accessToken)).send({ track: { trackId: 'steady', trackStart: null } }).expect(409);
      expect(live.body).toMatchObject({ code: 'track_not_for_section' });
      const publicTracks = (await t.http().get('/v1/tracks').expect(200)).body as { code: string; liveRecitation: boolean }[];
      expect(publicTracks.find(({ code }) => code === 'steady')?.liveRecitation).toBe(true);
      expect(publicTracks.find(({ code }) => code === recorded.code)?.liveRecitation).toBe(false);
      await t.http().patch('/v1/me').set(bearer(man.accessToken)).send({ track: { trackId: recorded.code, trackStart: null } }).expect(200);
      const goLive = await admin.patch(`/v1/admin/tracks/${recorded.id}`).send({ recitationMode: 'LIVE' }).expect(409);
      expect(goLive.body).toMatchObject({ code: 'track_has_men' });

      // A woman's circle takes no man, and a man can't teach it.
      const { circleId, student: woman } = await classroom();
      const womenTeacher = await newStaff('TEACHER', scopeA);
      const { id: womenCircle } = (await supervisorA.post('/v1/supervisor/circles').send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId: womenTeacher.id, trackId: recorded.id }).expect(201)).body as { id: string };
      const placed = await supervisorA.post(`/v1/supervisor/circles/${womenCircle}/students`).send({ studentId: man.id }).expect(409);
      expect(placed.body).toMatchObject({ code: 'section_mismatch' });
      const maleTeacher = await newStaff('TEACHER', scopeA, 'MEN');
      const swapped = await supervisorA.patch(`/v1/supervisor/circles/${circleId}`).send({ teacherId: maleTeacher.id }).expect(409);
      expect(swapped.body).toMatchObject({ code: 'section_mismatch' });

      // His own section's circle takes him.
      const { id: menCircle } = (await supervisorA.post('/v1/supervisor/circles').send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId: maleTeacher.id, trackId: recorded.id }).expect(201)).body as { id: string };
      await supervisorA.post(`/v1/supervisor/circles/${menCircle}/students`).send({ studentId: man.id }).expect(204);
      const profile = (await admin.get('/v1/staff/auth/me').expect(200)).body as { section: string };
      expect(profile.section).toBe('WOMEN');

      await t.app.get(NotificationsService).send([man.id, woman.id], { type: 'GENERAL', title: 'أحسنت{{|ِ}}', body: 'راسل{{|ي}} {{معلمك|معلمتك}}', dedupeKey: `section:${randomId()}` });
      const sent = await t.prisma.notification.findMany({ where: { userId: { in: [man.id, woman.id] }, type: 'GENERAL', title: { startsWith: 'أحسنت' } }, select: { userId: true, title: true, body: true } });
      expect(sent.find(({ userId }) => userId === man.id)).toMatchObject({ title: 'أحسنت', body: 'راسل معلمك' });
      expect(sent.find(({ userId }) => userId === woman.id)).toMatchObject({ title: 'أحسنتِ', body: 'راسلي معلمتك' });
    });
  });

  describe('badges', () => {
    const manual = {
      label: 'شارة',
      condition: null,
      look: { visual: 'EMOJI', icon: '🏅' },
      color: '#2FB59B',
      audience: 'STUDENTS',
      trigger: 'MANUAL',
      threshold: null,
      supervisorCanAward: true,
    };
    const create = async (fields: object) => ((await admin.post('/v1/admin/badges').send({ ...manual, ...fields }).expect(201)).body as { id: string }).id;
    type Listed = { id: string; visual: string; icon: string; condition: string | null; awarded: number };
    const listed = async (id: string) => ((await admin.get('/v1/admin/badges').expect(200)).body as { badges: Listed[] }).badges.find((badge) => badge.id === id)!;

    it('creates badges with an emoji or an icon, and checks the rule', async () => {
      const id = await create({});
      expect(await listed(id)).toMatchObject({ visual: 'EMOJI', icon: '🏅', awarded: 0 });

      await admin.post('/v1/admin/badges').send({ ...manual, look: { visual: 'EMOJI', icon: 'not an emoji' } }).expect(400);
      await admin.post('/v1/admin/badges').send({ ...manual, look: { visual: 'ICON', icon: 'not-an-icon' } }).expect(400);
      // An automatic rule needs its count, and is for students only.
      await admin.post('/v1/admin/badges').send({ ...manual, trigger: 'SURAH_PASSED' }).expect(400);
      await admin.post('/v1/admin/badges').send({ ...manual, trigger: 'WIRD_DAYS', threshold: 5, audience: 'STAFF' }).expect(400);

      const counted = await create({ trigger: 'PAGES_MEMORIZED', threshold: 3, look: { visual: 'ICON', icon: 'book-outline' } });
      expect((await listed(counted)).condition).toBe('حفظ 3 صفحات');
      await admin.patch(`/v1/admin/badges/${counted}`).send({ trigger: 'MANUAL' }).expect(400);
      await admin.patch(`/v1/admin/badges/${counted}`).send({ trigger: 'MANUAL', threshold: null, audience: 'EVERYONE', label: 'معدلة' }).expect(204);

      await supervisorA.post('/v1/admin/badges').send(manual).expect(403);
      await t.prisma.badge.deleteMany({ where: { id: { in: [id, counted] } } });
    });

    it('stores only a 256×256 PNG, and serves it publicly', async () => {
      const id = await create({ look: { visual: 'IMAGE' } });
      const png = (width: number, height: number) => {
        const header = Buffer.alloc(33);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
        header.writeUInt32BE(13, 8);
        header.write('IHDR', 12, 'ascii');
        header.writeUInt32BE(width, 16);
        header.writeUInt32BE(height, 20);
        return header;
      };
      const upload = (data: Buffer) => admin.put(`/v1/admin/badges/${id}/image`).attach('file', data, 'badge.png');

      expect((await upload(png(512, 512)).expect(400)).body).toMatchObject({ code: 'invalid_image_size' });
      expect((await upload(Buffer.from('GIF89a not a png')).expect(400)).body).toMatchObject({ code: 'unsupported_file_type' });
      const { imageUrl } = (await upload(png(256, 256)).expect(200)).body as { imageUrl: string };
      expect(imageUrl).toMatch(new RegExp(`^/badges/${id}/image\\?v=\\d+$`));

      const served = await t.http().get(`/v1${imageUrl}`).expect(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      await t.prisma.badge.delete({ where: { id } });
    });

    it('lets a supervisor give a badge in her scope only, once, and take back only her own', async () => {
      const { teacher, student } = await classroom();
      const outsider = await newStudent();
      const id = await create({ audience: 'EVERYONE' });
      const adminOnly = await create({ supervisorCanAward: false });

      await supervisorA.post('/v1/staff/badges/awards').send({ badgeId: id, userId: student.id, note: 'تميز' }).expect(204);
      expect((await supervisorA.post('/v1/staff/badges/awards').send({ badgeId: id, userId: student.id }).expect(409)).body).toMatchObject({ code: 'badge_already_held' });
      await supervisorA.post('/v1/staff/badges/awards').send({ badgeId: id, userId: teacher.id }).expect(204);
      // Outside her scope, or a badge she may not give.
      await supervisorA.post('/v1/staff/badges/awards').send({ badgeId: id, userId: outsider.id }).expect(404);
      await supervisorB.post('/v1/staff/badges/awards').send({ badgeId: id, userId: outsider.id }).expect(404);
      await supervisorA.post('/v1/staff/badges/awards').send({ badgeId: adminOnly, userId: outsider.id }).expect(404);

      expect(await t.prisma.notification.count({ where: { userId: student.id, type: 'BADGES' } })).toBe(1);
      const mine = (await teacher.client.get('/v1/staff/badges/mine').expect(200)).body as { id: string }[];
      expect(mine.map((badge) => badge.id)).toEqual([id]);
      const board = (await t.http().get('/v1/me/badge-board').set(bearer(student.accessToken)).expect(200)).body as { badges: { id: string; awardedAt: string | null; note: string | null }[] };
      expect(board.badges.find((badge) => badge.id === id)).toMatchObject({ note: 'تميز' });

      // The administration gives to anyone, and a badge goes only to its audience.
      await admin.post('/v1/staff/badges/awards').send({ badgeId: adminOnly, userId: outsider.id }).expect(204);
      expect((await admin.post('/v1/staff/badges/awards').send({ badgeId: adminOnly, userId: teacher.id }).expect(409)).body).toMatchObject({ code: 'badge_not_for_recipient' });

      await supervisorB.delete(`/v1/staff/badges/awards/${id}/${student.id}`).expect(404);
      await supervisorA.delete(`/v1/staff/badges/awards/${adminOnly}/${outsider.id}`).expect(404);
      await supervisorA.delete(`/v1/staff/badges/awards/${id}/${student.id}`).expect(204);
      await teacher.client.post('/v1/staff/badges/awards').send({ badgeId: id, userId: student.id }).expect(403);
      await t.prisma.badge.deleteMany({ where: { id: { in: [id, adminOnly] } } });
    });

    it('pins up to three badges, shown to those who can see the holder', async () => {
      const { teacher, student } = await classroom();
      const ids = [await create({}), await create({}), await create({}), await create({})];
      for (const badgeId of ids) await admin.post('/v1/staff/badges/awards').send({ badgeId, userId: student.id }).expect(204);
      const pin = (badgeIds: string[]) => t.http().put('/v1/me/badges/pins').set(bearer(student.accessToken)).send({ badgeIds });

      await pin(ids).expect(400);
      // Only badges she holds.
      await pin([randomId()]).expect(404);
      await pin([ids[2], ids[0]]).expect(204);

      type Shown = Record<string, { pinned: { id: string }[]; total: number }>;
      const seen = (await teacher.client.get(`/v1/staff/badges/showcase?ids=${student.id}`).expect(200)).body as Shown;
      expect(seen[student.id].total).toBe(4);
      expect(seen[student.id].pinned.map(({ id }) => id)).toEqual([ids[2], ids[0]]);
      await supervisorA.get(`/v1/staff/badges/of/${student.id}`).expect(200);
      // Outside her reach, a supervisor sees nothing.
      expect((await supervisorB.get(`/v1/staff/badges/showcase?ids=${student.id}`).expect(200)).body).toEqual({});
      await supervisorB.get(`/v1/staff/badges/of/${student.id}`).expect(404);

      // Her teacher's pinned badge shows in her circle.
      const staffBadge = await create({ audience: 'STAFF' });
      await admin.post('/v1/staff/badges/awards').send({ badgeId: staffBadge, userId: teacher.id }).expect(204);
      await teacher.client.put('/v1/staff/badges/mine/pins').send({ badgeIds: [staffBadge] }).expect(204);
      const circle = (await t.http().get('/v1/me/circle').set(bearer(student.accessToken)).expect(200)).body as { teacherBadges: { pinned: { id: string }[] } };
      expect(circle.teacherBadges.pinned.map(({ id }) => id)).toEqual([staffBadge]);

      await t.prisma.badge.deleteMany({ where: { id: { in: [...ids, staffBadge] } } });
    });

    it('manages encouragement messages, and sends them on Saturday only when on, to all but those who declined', async () => {
      const text = `رسالة ${randomId().slice(0, 6)}`;
      await admin.post('/v1/admin/encouragement-messages').send({ text }).expect(204);
      await admin.post('/v1/admin/encouragement-messages').send({ text }).expect(409);

      const wants = await newStudent();
      const declines = await newStudent();
      await t.http().patch('/v1/me').set(bearer(declines.accessToken)).send({ preferences: { notifications: { encouragement: false } } }).expect(200);
      const saturday = new Date('2026-11-14T09:00:00Z');
      const service = t.app.get(NotificationsService);
      const countFor = (id: string) => t.prisma.notification.count({ where: { userId: id, type: 'ENCOURAGEMENT' } });

      await admin.put('/v1/admin/settings/features').send({ englishEnabled: true, smartRecitation: true, offlineRecitation: true, encouragementEnabled: false }).expect(204);
      await service.sendWeeklyEncouragement(saturday);
      expect(await countFor(wants.id)).toBe(0);

      await admin.put('/v1/admin/settings/features').send({ englishEnabled: true, smartRecitation: true, offlineRecitation: true, encouragementEnabled: true }).expect(204);
      await service.sendWeeklyEncouragement(new Date('2026-11-13T09:00:00Z'));
      expect(await countFor(wants.id)).toBe(0);
      await service.sendWeeklyEncouragement(saturday);
      await service.sendWeeklyEncouragement(saturday);
      expect(await countFor(wants.id)).toBe(1);
      expect(await countFor(declines.id)).toBe(0);
    });

    it('honors a circle once a month, and tells its students and its teacher', async () => {
      const room = await classroom();
      const noCertificates = { studentTemplateId: null, teacherTemplateId: null };
      await admin.post(`/v1/admin/circles/${room.circleId}/honor`).send(noCertificates).expect(201);
      await admin.post(`/v1/admin/circles/${room.circleId}/honor`).send(noCertificates).expect(409);
      expect(await t.prisma.notification.count({ where: { userId: room.student.id, dedupeKey: { startsWith: 'honor:' } } })).toBe(1);
      expect(await t.prisma.notification.count({ where: { userId: room.teacher.id, dedupeKey: { startsWith: 'honor-certificate:' } } })).toBe(1);
      expect(await t.prisma.issuedCertificate.count({ where: { circleId: room.circleId } })).toBe(0);
    });

    it('gives the chosen circle certificates to its students and its teacher', async () => {
      const room = await classroom();
      const design = async (trigger: 'CIRCLE_HONOR' | 'CIRCLE_HONOR_TEACHER') =>
        (
          (
            await admin
              .post('/v1/admin/certificates')
              .send({
                name: `تكريم ${randomId().slice(0, 6)}`,
                trigger,
                width: 842,
                height: 595,
                elements: [{ id: 'name', type: 'text', x: 0, y: 0, w: 800, h: 40, text: '{{name}} · {{circle}} · {{note}}', size: 20, bold: true, color: '#000000', align: 'center' }],
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const studentDesign = await design('CIRCLE_HONOR');
      const teacherDesign = await design('CIRCLE_HONOR_TEACHER');

      type Options = { circle: { name: string }; students: { templates: { id: string }[] }; teacher: { templates: { id: string }[]; values: { name: string } } | null };
      const options = (await admin.get(`/v1/admin/circles/${room.circleId}/honor`).expect(200)).body as Options;
      expect(options.students.templates.map(({ id }) => id)).toContain(studentDesign);
      expect(options.teacher?.templates.map(({ id }) => id)).toContain(teacherDesign);
      expect(options.teacher?.templates.map(({ id }) => id)).not.toContain(studentDesign);

      const { body } = await admin
        .post(`/v1/admin/circles/${room.circleId}/honor`)
        .send({ studentTemplateId: studentDesign, teacherTemplateId: teacherDesign, note: 'تقديرًا للتميز' })
        .expect(201);
      expect(body).toEqual({ studentCertificates: 1, teacherCertificate: true });

      // The student finds hers in the app.
      const held = (await t.http().get('/v1/me/certificates').set(bearer(room.student.accessToken)).expect(200)).body as { id: string; title: string }[];
      const studentCopy = held.find(({ title }) => title.startsWith('تكريم'));
      expect(studentCopy).toBeDefined();
      const studentPage = (await t.http().get(`/v1/me/certificates/${studentCopy!.id}`).set(bearer(room.student.accessToken)).expect(200)).body as { elements: { text?: string }[] };
      expect(studentPage.elements[0].text).toContain(options.circle.name);
      expect(studentPage.elements[0].text).toContain('تقديرًا للتميز');

      // The teacher finds hers on the dashboard, and only hers.
      const mine = (await room.teacher.client.get('/v1/staff/certificates/mine').expect(200)).body as { id: string }[];
      expect(mine).toHaveLength(1);
      const teacherPage = (await room.teacher.client.get(`/v1/staff/certificates/mine/${mine[0].id}`).expect(200)).body as { elements: { text?: string }[] };
      expect(teacherPage.elements[0].text).toContain(options.teacher!.values.name);
      await room.teacher.client.get(`/v1/staff/certificates/mine/${studentCopy!.id}`).expect(404);

      await t.prisma.certificateTemplate.deleteMany({ where: { id: { in: [studentDesign, teacherDesign] } } });
    });

    it('keeps signatures without a background, prints them on certificates, and keeps those in use', async () => {
      // A 2×2 PNG: colour type 6 has an alpha channel, colour type 2 has none and so keeps its background.
      const png = (colorType: 2 | 6) => {
        const chunk = (type: string, data: Buffer) => {
          const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(data.length);
          const crc = Buffer.alloc(4);
          crc.writeUInt32BE(zlib.crc32(body));
          return Buffer.concat([length, body, crc]);
        };
        const header = Buffer.alloc(13);
        header.writeUInt32BE(2, 0);
        header.writeUInt32BE(2, 4);
        header[8] = 8;
        header[9] = colorType;
        const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(2 * (colorType === 6 ? 4 : 3))]);
        return Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          chunk('IHDR', header),
          chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))),
          chunk('IEND', Buffer.alloc(0)),
        ]);
      };
      const upload = (file: Buffer, name = 'توقيع المشرفة') =>
        admin.post('/v1/admin/certificates/assets').field('name', name).field('kind', 'SIGNATURE').attach('file', file, 'signature.png');

      await upload(png(2)).expect(400);
      await upload(Buffer.from('not a picture')).expect(400);
      const { id: assetId } = (await upload(png(6)).expect(201)).body as { id: string };
      const library = (await admin.get('/v1/admin/certificates/assets').expect(200)).body as { id: string; width: number; src: string }[];
      expect(library.find(({ id }) => id === assetId)).toMatchObject({ width: 2, src: expect.stringMatching(/^data:image\/png;base64,/) });

      const { id: designId } = (
        await admin
          .post('/v1/admin/certificates')
          .send({ name: 'شهادة موقّعة', trigger: 'MANUAL', width: 842, height: 595, elements: [{ id: 'sign', type: 'image', assetId, x: 100, y: 450, w: 160, h: 80 }] })
          .expect(201)
      ).body as { id: string };
      const design = (await admin.get(`/v1/admin/certificates/${designId}`).expect(200)).body as { elements: { src?: string }[] };
      expect(design.elements[0].src).toMatch(/^data:image\/png;base64,/);

      // The student's certificate carries the signature's picture.
      const room = await classroom();
      await admin.post(`/v1/admin/certificates/${designId}/issue`).send({ studentIds: [room.student.id] }).expect(201);
      const held = (await t.http().get('/v1/me/certificates').set(bearer(room.student.accessToken)).expect(200)).body as { id: string; title: string }[];
      const copy = held.find(({ title }) => title === 'شهادة موقّعة');
      const page = (await t.http().get(`/v1/me/certificates/${copy!.id}`).set(bearer(room.student.accessToken)).expect(200)).body as { elements: { type: string; src?: string }[] };
      expect(page.elements[0]).toMatchObject({ type: 'image', src: expect.stringMatching(/^data:image\/png;base64,/) });

      // A signature in use can't be deleted; once no design places it, it can.
      await admin.delete(`/v1/admin/certificates/assets/${assetId}`).expect(409);
      await admin.delete(`/v1/admin/certificates/${designId}`).expect(204);
      await admin.delete(`/v1/admin/certificates/assets/${assetId}`).expect(204);
      expect(await t.prisma.certificateAsset.count({ where: { id: assetId } })).toBe(0);
    });
  });

  describe('announcements and alerts', () => {
    const broadcast = (body: object) => admin.post('/v1/admin/broadcasts').send({ kind: 'ANNOUNCEMENT', title: 'عنوان', body: 'نص', audience: { type: 'ALL' }, ...body });
    const visibleTo = async (token: string) => (await t.http().get('/v1/me/announcements').set(bearer(token)).expect(200)).body as { id: string }[];

    it('delivers an alert to its circle only', async () => {
      const inside = await classroom();
      const outside = await classroom();
      const { recipients } = (await broadcast({ kind: 'ALERT', audience: { type: 'CIRCLE', circleId: inside.circleId } }).expect(201)).body as { recipients: number };
      expect(recipients).toBe(1);
      const list = async (token: string) => (await t.http().get('/v1/me/notifications').set(bearer(token)).expect(200)).body as { id: string; readAt: string | null }[];
      const [item] = await list(inside.student.accessToken);
      expect(item).toBeDefined();
      expect(await list(outside.student.accessToken)).toEqual([]);

      await t.http().post(`/v1/me/notifications/${item.id}/read`).set(bearer(outside.student.accessToken)).expect(204);
      expect((await list(inside.student.accessToken))[0].readAt).toBeNull();
      await t.http().post(`/v1/me/notifications/${item.id}/read`).set(bearer(inside.student.accessToken)).expect(204);
      expect((await list(inside.student.accessToken))[0].readAt).not.toBeNull();
    });

    it('respects a student who turned that notification off', async () => {
      const room = await classroom();
      await t.http().patch('/v1/me').set(bearer(room.student.accessToken)).send({ preferences: { notifications: { general: false } } }).expect(200);
      const { recipients } = (await broadcast({ kind: 'ALERT', audience: { type: 'CIRCLE', circleId: room.circleId } }).expect(201)).body as { recipients: number };
      expect(recipients).toBe(0);
    });

    it('shows an announcement through its period, to its audience', async () => {
      const room = await classroom();
      const other = await classroom();
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; code: string }[];
      const steady = tracks.find(({ code }) => code === 'steady')!;
      const advanced = tracks.find(({ code }) => code === 'advanced')!;
      const hour = 3_600_000;

      const circle = (await broadcast({ audience: { type: 'CIRCLE', circleId: room.circleId } }).expect(201)).body as { id: string };
      const track = (await broadcast({ audience: { type: 'TRACK', trackId: steady.id } }).expect(201)).body as { id: string };
      const otherTrack = (await broadcast({ audience: { type: 'TRACK', trackId: advanced.id } }).expect(201)).body as { id: string };
      const later = (await broadcast({ startsAt: new Date(Date.now() + hour).toISOString() }).expect(201)).body as { id: string };
      const past = (await broadcast({ startsAt: new Date(Date.now() - 2 * hour).toISOString(), endsAt: new Date(Date.now() - hour).toISOString() }).expect(201)).body as { id: string };

      const mine = (await visibleTo(room.student.accessToken)).map(({ id }) => id);
      expect(mine).toContain(circle.id);
      expect(mine).toContain(track.id);
      expect(mine).not.toContain(otherTrack.id);
      expect(mine).not.toContain(later.id);
      expect(mine).not.toContain(past.id);
      expect((await visibleTo(other.student.accessToken)).map(({ id }) => id)).not.toContain(circle.id);

      const { items } = (await admin.get('/v1/admin/broadcasts').expect(200)).body as { items: { id: string; status: string }[] };
      const statusOf = (id: string) => items.find((item) => item.id === id)?.status;
      expect(statusOf(circle.id)).toBe('visible');
      expect(statusOf(later.id)).toBe('scheduled');
      expect(statusOf(past.id)).toBe('ended');
    });

    it('can be ended or deleted', async () => {
      const student = await newStudent();
      const { id } = (await broadcast({}).expect(201)).body as { id: string };
      expect((await visibleTo(student.accessToken)).map((item) => item.id)).toContain(id);
      await admin.post(`/v1/admin/broadcasts/${id}/end`).expect(204);
      await admin.post(`/v1/admin/broadcasts/${id}/end`).expect(404);
      expect((await visibleTo(student.accessToken)).map((item) => item.id)).not.toContain(id);
      await admin.delete(`/v1/admin/broadcasts/${id}`).expect(204);
      await admin.delete(`/v1/admin/broadcasts/${id}`).expect(404);
    });

    it('rejects a backward period, and a period on an alert', async () => {
      const now = Date.now();
      await broadcast({ startsAt: new Date(now + 2000).toISOString(), endsAt: new Date(now).toISOString() }).expect(400);
      await broadcast({ kind: 'ALERT', startsAt: new Date(now).toISOString() }).expect(400);
    });

    it('shows a supervisor what the administration sent', async () => {
      const { id } = (await broadcast({ title: 'من الإدارة' }).expect(201)).body as { id: string };
      const items = (await supervisorA.get('/v1/supervisor/announcements/incoming').expect(200)).body as { id: string; status: string }[];
      expect(items.find((item) => item.id === id)?.status).toBe('visible');
    });
  });

  describe('supervisor follow-up', () => {
    it('sends one reminder a day, and only within the scope', async () => {
      const room = await classroom();
      expect((await supervisorA.post(`/v1/supervisor/students/${room.student.id}/remind`).expect(200)).body).toEqual({ sent: true });
      expect((await supervisorA.post(`/v1/supervisor/students/${room.student.id}/remind`).expect(200)).body).toEqual({ sent: false });
      await supervisorB.post(`/v1/supervisor/students/${room.student.id}/remind`).expect(404);
      await supervisorB.get(`/v1/supervisor/plans?circleId=${room.circleId}`).expect(200);
    });

    it('reports stage exams, counting a student\'s latest try once', async () => {
      const room = await classroom();
      const exam = (score: number) => room.teacher.client.post('/v1/teacher/stage-exams').send({ studentId: room.student.id, stage: 1, score }).expect(201);
      expect((await exam(5)).body).toMatchObject({ passed: false });
      expect((await exam(9)).body).toMatchObject({ passed: true });

      const report = (await supervisorA.get(`/v1/supervisor/reports/stage?circleId=${room.circleId}`).expect(200)).body as StageBody;
      expect(report.stats).toMatchObject({ tested: 1, passed: 1, passRate: 100, average: 9, needRetake: 0 });
      expect(report.byCircle[0]).toMatchObject({ circleId: room.circleId, stage: 1, tested: 1 });

      const outside = (await supervisorB.get('/v1/supervisor/reports/stage').expect(200)).body as StageBody;
      expect(outside.stats.tested).toBe(0);
    });

    it('will not take an exam for another teacher\'s student', async () => {
      const room = await classroom();
      const other = await classroom();
      await other.teacher.client.post('/v1/teacher/stage-exams').send({ studentId: room.student.id, stage: 1, score: 9 }).expect(404);
    });

    it('records attendance alone, which counts as attendance and not as a recitation', async () => {
      const room = await classroom();
      const other = await classroom();
      await other.teacher.client.post('/v1/teacher/attendance').send({ studentId: room.student.id, attendance: 'PRESENT' }).expect(404);
      await room.teacher.client.post('/v1/teacher/attendance').send({ studentId: room.student.id, attendance: 'PRESENT' }).expect(201);
      await room.teacher.client.post('/v1/teacher/attendance').send({ studentId: room.student.id, attendance: 'SOMETIMES' }).expect(400);

      const { rows } = (await room.teacher.client.get('/v1/teacher/reports').expect(200)).body as { rows: { attendanceRate: number; recitations: number }[] };
      expect(rows[0]).toMatchObject({ attendanceRate: 100, recitations: 0 });
      const list = (await room.teacher.client.get('/v1/teacher/recitations').expect(200)).body as { total: number };
      expect(list.total).toBe(0);
    });

    it('shows gate decisions and notes in the teacher\'s activity', async () => {
      const room = await classroom();
      await onShortPlan(room.student.id, [113, 114], 'TEACHER');
      await complete(room.student.accessToken).expect(204);
      const [gate] = (await room.teacher.client.get('/v1/teacher/gates').expect(200)).body as { id: string }[];
      await room.teacher.client.post(`/v1/teacher/gates/${gate.id}/approve`).send({ score: 9 }).expect(204);
      await room.teacher.client.post('/v1/teacher/recitations').send({ studentId: room.student.id, surah: 18, fromAyah: 1, toAyah: 2, ...MASTERED, note: 'انتبهي' }).expect(201);

      const activity = (await supervisorA.get(`/v1/supervisor/teachers/${room.teacher.id}/activity`).expect(200)).body as { kind: string }[];
      expect(activity.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['gate', 'note']));
    });

    it('charts pages memorized and pages heard', async () => {
      const room = await classroom();
      await complete(room.student.accessToken).expect(204);
      await room.teacher.client.post('/v1/teacher/recitations').send({ studentId: room.student.id, surah: 18, fromAyah: 1, toAyah: 10, ...MASTERED }).expect(201);
      const [row] = (await room.teacher.client.get('/v1/teacher/reports/weekly-pages').expect(200)).body as { memorized: number[]; reviewed: number[] }[];
      expect(row.memorized.at(-1)).toBeGreaterThan(0);
      expect(row.reviewed.at(-1)).toBeGreaterThan(0);
    });

    it('limits the stage report to a period', async () => {
      const room = await classroom();
      await room.teacher.client.post('/v1/teacher/stage-exams').send({ studentId: room.student.id, stage: 1, score: 9 }).expect(201);
      await t.prisma.stageExam.updateMany({ where: { studentId: room.student.id }, data: { createdAt: dateOnly(-40) } });
      const recent = (await supervisorA.get(`/v1/supervisor/reports/stage?circleId=${room.circleId}&days=30`).expect(200)).body as StageBody;
      expect(recent.stats.tested).toBe(0);
      const all = (await supervisorA.get(`/v1/supervisor/reports/stage?circleId=${room.circleId}`).expect(200)).body as StageBody;
      expect(all.stats.tested).toBe(1);
    });

    it('reports gates and activity', async () => {
      const room = await classroom();
      await room.teacher.client.post('/v1/teacher/recitations').send({ studentId: room.student.id, surah: 18, fromAyah: 1, toAyah: 5, ...MASTERED }).expect(201);
      const activity = (await supervisorA.get('/v1/supervisor/reports/activity').expect(200)).body as { circleId: string; recitations: number; attendanceRate: number }[];
      expect(activity.find(({ circleId }) => circleId === room.circleId)).toMatchObject({ recitations: 1, attendanceRate: 100 });
      const gates = (await supervisorA.get(`/v1/supervisor/reports/gates?circleId=${room.circleId}`).expect(200)).body as { pending: number }[];
      expect(gates[0].pending).toBe(0);
    });

    it('shows commitment on the home page', async () => {
      const room = await classroom();
      await t.prisma.studentPlan.update({ where: { studentId: room.student.id }, data: { startOn: dateOnly(-7) } });
      const { circles } = (await supervisorA.get('/v1/supervisor/home').expect(200)).body as { circles: { id: string; commitment: number | null }[] };
      expect(circles.find(({ id }) => id === room.circleId)?.commitment).toBe(0);
    });
  });

  describe('tasks from the student\'s side', () => {
    it('counts a completion once, and only for the student\'s own circle', async () => {
      const room = await classroom();
      const other = await classroom();
      const { id } = (await room.teacher.client.post('/v1/teacher/tasks').send({ title: 'يوميًا', recurrence: 'DAILY' }).expect(201)).body as { id: string };
      const send = (token: string) => t.http().post(`/v1/me/tasks/${id}/complete`).set(bearer(token));

      await send(other.student.accessToken).expect(404);
      await send(room.student.accessToken).expect(204);
      await send(room.student.accessToken).expect(204);

      const tasks = (await room.teacher.client.get('/v1/teacher/tasks').expect(200)).body as { completed: number; total: number; status: string }[];
      expect(tasks[0]).toMatchObject({ completed: 1, total: 1, status: 'done' });

      const circle = (await t.http().get('/v1/me/circle').set(bearer(room.student.accessToken)).expect(200)).body as { tasks: { done: boolean }[] };
      expect(circle.tasks[0].done).toBe(true);
    });

    it('hides a task meant for one student from the others', async () => {
      const room = await classroom();
      const classmate = await newStudent();
      await supervisorA.post(`/v1/supervisor/circles/${room.circleId}/students`).send({ studentId: classmate.id }).expect(204);
      const { id } = (await room.teacher.client.post('/v1/teacher/tasks').send({ title: 'خاصة', studentId: room.student.id, recurrence: 'DAILY' }).expect(201)).body as { id: string };
      await t.http().post(`/v1/me/tasks/${id}/complete`).set(bearer(classmate.accessToken)).expect(404);
      const circle = (await t.http().get('/v1/me/circle').set(bearer(classmate.accessToken)).expect(200)).body as { tasks: object[] };
      expect(circle.tasks).toEqual([]);
    });
  });

  describe('accounts and students', () => {
    it('masks phone numbers in lists, and filters', async () => {
      const student = await newStudent();
      const { items } = (await admin.get('/v1/admin/students?status=awaitingAssignment&limit=100').expect(200)).body as { items: { id: string; phone: string; status: string }[] };
      const row = items.find(({ id }) => id === student.id);
      expect(row?.status).toBe('awaitingAssignment');
      expect(row?.phone).toMatch(/^\+966 ••• ••\d\d$/);
      expect(row?.phone).not.toContain(student.phone.slice(5));
    });

    it('adds a student, who then signs in with that number', async () => {
      const phone = newPhone();
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; code: string }[];
      const trackId = tracks.find(({ code }) => code === 'steady')!.id;
      await admin.post('/v1/admin/students').send({ fullName: 'طالبة مضافة', phone, country: 'مصر', trackId, section: 'WOMEN' }).expect(201);
      await admin.post('/v1/admin/students').send({ fullName: 'نسخة', phone, country: 'مصر', trackId, section: 'WOMEN' }).expect(409);

      await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'login' }).expect(202);
      const { body } = await t.http().post('/v1/auth/otp/verify').send({ phone, code: t.codeFor(phone) }).expect(200);
      expect((body as { accessToken: string }).accessToken).toBeTruthy();
    });

    it('lets staff sign in by phone, with no email', async () => {
      const phone = newPhone();
      const { body } = await admin.post('/v1/admin/staff').send({ fullName: 'معلمة بالجوال', phone, role: 'TEACHER', scopeId: scopeA }).expect(201);
      await agent().post('/v1/staff/auth/password/set').send({ token: (body as { setupToken: string }).setupToken, password: PASSWORD }).expect(204);
      await agent().post('/v1/staff/auth/login').send({ identifier: phone, password: PASSWORD }).expect(200);
      await admin.post('/v1/admin/staff').send({ fullName: 'لا شيء', role: 'TEACHER', scopeId: scopeA }).expect(400);
    });

    it('creates a circle with no teacher, for one new teacher to take', async () => {
      const { id } = (await admin.post('/v1/admin/circles').send({ name: `حلقة ${randomId().slice(0, 5)}`, scopeId: scopeA, trackId: await trackIdOf(t) }).expect(201)).body as { id: string };
      const list = (await admin.get('/v1/admin/circles').expect(200)).body as { id: string; teacher: object | null }[];
      expect(list.find((circle) => circle.id === id)?.teacher).toBeNull();

      await admin.post('/v1/admin/staff').send({ fullName: 'أ', email: uniqueEmail(), role: 'TEACHER', scopeId: scopeA, circleId: id }).expect(201);
      expect((await admin.post('/v1/admin/staff').send({ fullName: 'ب', email: uniqueEmail(), role: 'TEACHER', scopeId: scopeA, circleId: id }).expect(409)).body).toMatchObject({ code: 'circle_not_free' });
      await admin.post('/v1/admin/staff').send({ fullName: 'ج', email: uniqueEmail(), role: 'SUPERVISOR', scopeId: scopeA, circleId: id }).expect(400);
    });

    it('will not hand a new teacher a circle in another scope', async () => {
      const { id } = (await admin.post('/v1/admin/circles').send({ name: `حلقة ${randomId().slice(0, 5)}`, scopeId: scopeB, trackId: await trackIdOf(t) }).expect(201)).body as { id: string };
      await admin.post('/v1/admin/staff').send({ fullName: 'أ', email: uniqueEmail(), role: 'TEACHER', scopeId: scopeA, circleId: id }).expect(409);
    });

    it('gives the overview real totals', async () => {
      const { stats, byCountry, byTrack } = (await admin.get('/v1/admin/overview').expect(200)).body as OverviewBody;
      const students = await t.prisma.user.count({ where: { role: 'STUDENT' } });
      expect(stats.students).toBe(students);
      expect(byCountry.reduce((sum, row) => sum + row.students, 0)).toBe(students);
      expect(byTrack.length).toBeGreaterThanOrEqual(4);
      const report = (await admin.get('/v1/admin/reports/program').expect(200)).body as { scopes: { id: string }[] };
      expect(report.scopes.map(({ id }) => id)).toContain(scopeA);
    });

    it('fills every section of the program report', async () => {
      const room = await classroom();
      await room.teacher.client.post('/v1/teacher/attendance').send({ studentId: room.student.id, attendance: 'PRESENT' }).expect(201);
      const report = (await admin.get('/v1/admin/reports/program?days=30').expect(200)).body as ProgramReportBody;
      expect(report.months).toHaveLength(6);
      expect(report.totals.attendanceRate).not.toBeNull();
      expect(report.attendance.present).toBeGreaterThanOrEqual(1);
      expect(report.teachers.map(({ id }) => id)).toContain(room.teacher.id);
      const circle = report.circles.find(({ id }) => id === room.circleId);
      expect(circle).toMatchObject({ students: 1, attendanceRate: 100 });
      expect(report.activity.newStudents).toBeGreaterThanOrEqual(1);
    });
  });
});

interface ProgramBody {
  summary: { status: string; nextLabel: string | null; completedUnits: number; passedSurahs: number; commitment: number | null };
  week: { days: object[] } | null;
  gate: object | null;
}
interface GateBody {
  id: string;
  surah: number;
  tafsir: { required: boolean };
  wrap: { required: boolean };
  exam: { required: boolean; due: boolean };
}
interface PlansBody {
  stats: object;
  behind: { studentId: string }[];
  circles: { commitment: number | null }[];
}
interface StageBody {
  stats: { tested: number };
  byCircle: object[];
}
interface ProgramReportBody {
  totals: { attendanceRate: number | null };
  months: object[];
  attendance: { present: number };
  teachers: { id: string }[];
  circles: { id: string; students: number; attendanceRate: number | null }[];
  activity: { newStudents: number };
}
interface OverviewBody {
  stats: { students: number };
  byCountry: { students: number }[];
  byTrack: object[];
}
