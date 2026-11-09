import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { SURAHS } from '../src/common/surahs.js';
import { NotificationsService } from '../src/program/notifications.service.js';
import { createTestApp, keepStaffSignedIn, newPhone, register, type TestApp, finishWirdSteps, trackIdOf } from './helpers.js';

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

  async function newStaff(role: 'TEACHER' | 'SUPERVISOR', scopeId: string) {
    const email = uniqueEmail();
    const { body } = await admin.post('/v1/admin/staff').send({ fullName: `${role} اختبار`, email, role, scopeId }).expect(201);
    const created = body as { staff: { id: string }; setupToken: string };
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
    if (role === 'SUPERVISOR') return { id: created.staff.id, client: await enroll(email), email };
    const client = agent();
    await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    return { id: created.staff.id, client, email };
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newStudent() {
    const reg = await register(t);
    const { id } = (await t.http().get('/v1/me').set(bearer(reg.accessToken)).expect(200)).body as { id: string };
    return { ...reg, id };
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
      .send({ kind: 'MEMORIZATION', name: `مسار ${randomId().slice(0, 6)}`, audience: 'اختبار', duration: 'شهر', dailyUnit: 'SURAH', wirdDays: [0, 1, 2, 3, 4, 5, 6], consolidationDays: 0 })
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
        .send({ phone, code: t.codeFor(phone), registration: { fullName: 'سارة علي أحمد', country: 'مصر', ageBand: '20', trackId: 'stabilization', trackStart: 'fatiha', pledgesAccepted: true } })
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

      // Decided once, and the next surah opens.
      await approve(room, id, 9).expect(404);
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
    const memorization = { kind: 'MEMORIZATION', name: 'مسار جديد', audience: 'الجميع', duration: 'سنة', dailyUnit: 'PAGE', wirdDays: [0, 1], consolidationDays: 1 };

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
      const { id } = (await admin.post('/v1/admin/tracks').send({ kind: 'CORRECTION', name: 'x', audience: 'x', duration: 'x', focus: 'x', sessionsPerWeek: 2, application: 'x' }).expect(201)).body as { id: string };
      expect((await admin.patch(`/v1/admin/tracks/${id}`).send({ dailyUnit: 'PAGE' }).expect(400)).body).toMatchObject({ code: 'field_not_for_this_track' });
    });

    it('registers a student on a track the administrator added, and refuses a correction track', async () => {
      const dto = { name: 'مسار مضاف', audience: 'الجميع', duration: 'سنة' };
      const added = (await admin.post('/v1/admin/tracks').send({ kind: 'MEMORIZATION', ...dto, dailyUnit: 'PAGE', wirdDays: [0, 1], consolidationDays: 1 }).expect(201)).body as { id: string };
      const tracks = (await admin.get('/v1/admin/tracks').expect(200)).body as { id: string; code: string }[];
      const { code } = tracks.find(({ id }) => id === added.id)!;

      const register = async (trackId: string) => {
        const phone = newPhone();
        await t.http().post('/v1/auth/otp/request').send({ phone, purpose: 'register' }).expect(202);
        return t
          .http()
          .post('/v1/auth/otp/verify')
          .send({ phone, code: t.codeFor(phone), registration: { fullName: 'نورة علي أحمد', country: 'مصر', ageBand: '20', trackId, trackStart: null, pledgesAccepted: true } });
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
          .send({ phone, code: t.codeFor(phone), registration: { fullName: 'نورة علي أحمد', country: 'مصر', ageBand: '20', trackId: 'advanced', trackStart: null, pledgesAccepted: true } })
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

        const list = (await supervisorA.get('/v1/admissions').expect(200)).body as { id: string; phone: string }[];
        expect(list.some(({ id }) => id === student.id)).toBe(true);
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

  describe('motivation', () => {
    it('adds a manual badge, and only one badge for each automatic event', async () => {
      const fields = { label: 'شارة', condition: 'شرط', icon: 'medal-outline' };
      const { id } = (await admin.post('/v1/admin/badges').send({ ...fields, trigger: 'MANUAL' }).expect(201)).body as { id: string };
      const { badges } = (await admin.get('/v1/admin/motivation').expect(200)).body as { badges: { id: string; icon: string }[] };
      expect(badges.find((badge) => badge.id === id)?.icon).toBe('medal-outline');
      // The test data already has a badge for passing a surah.
      const { body } = await admin.post('/v1/admin/badges').send({ ...fields, trigger: 'SURAH_PASSED' }).expect(409);
      expect(body).toMatchObject({ code: 'badge_trigger_taken' });
      await t.prisma.badge.delete({ where: { id } });
    });

    it('edits a badge, awards it once, and tells the student', async () => {
      const { badges } = (await admin.get('/v1/admin/motivation').expect(200)).body as { badges: { id: string; code: string }[] };
      const mastery = badges.find(({ code }) => code === 'mastery')!;
      await admin.patch(`/v1/admin/badges/${mastery.id}`).send({ condition: 'إتقان 95%' }).expect(204);

      const student = await newStudent();
      await admin.post(`/v1/admin/students/${student.id}/badges`).send({ badgeId: mastery.id }).expect(204);
      await admin.post(`/v1/admin/students/${student.id}/badges`).send({ badgeId: mastery.id }).expect(204);
      expect(await t.prisma.studentBadge.count({ where: { studentId: student.id } })).toBe(1);
      expect(await t.prisma.notification.count({ where: { userId: student.id, type: 'BADGES' } })).toBe(1);
    });

    it('does not give a badge to a staff member', async () => {
      const { badges } = (await admin.get('/v1/admin/motivation').expect(200)).body as { badges: { id: string }[] };
      const teacher = await newStaff('TEACHER', scopeA);
      await admin.post(`/v1/admin/students/${teacher.id}/badges`).send({ badgeId: badges[0].id }).expect(404);
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

    it('honors a circle once a month, and tells its students', async () => {
      const room = await classroom();
      await admin.post(`/v1/admin/circles/${room.circleId}/honor`).expect(204);
      await admin.post(`/v1/admin/circles/${room.circleId}/honor`).expect(204);
      expect(await t.prisma.notification.count({ where: { userId: room.student.id, dedupeKey: { startsWith: 'honor:' } } })).toBe(1);
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
interface OverviewBody {
  stats: { students: number };
  byCountry: { students: number }[];
  byTrack: object[];
}
