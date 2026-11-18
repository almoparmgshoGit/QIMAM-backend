import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { createTestApp, finishWirdSteps, keepStaffSignedIn, newPhone, nextWirdDay, register, type TestApp, trackIdOf } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';
type Agent = ReturnType<typeof request.agent>;

const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

interface ExamSession {
  id: string;
  stage: number;
  status: string;
  retake: boolean;
  scheduledAt: string | null;
  examiner: { id: string } | null;
  result: { score: number; passed: boolean } | null;
}
interface StudentExams {
  mode: string;
  holdsBack: boolean;
  exams: (ExamSession & { canBook: boolean; slots: { id: string }[] })[];
  history: { stage: number; passed: boolean }[];
}

describe('stage exams', () => {
  let t: TestApp;
  let admin: Agent;
  let scopeA: string;
  let supervisorA: Agent;
  let supervisorB: Agent;
  const agent = (): Agent => request.agent(t.app.getHttpServer()).set('Origin', ORIGIN);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

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
    if (role === 'SUPERVISOR') return { id: created.staff.id, client: await enroll(email) };
    const client = agent();
    await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    return { id: created.staff.id, client };
  }

  /**
   * A teacher's circle in scope A with one student, on a surah-by-surah track of An-Nisa then Al-Ma'ida, so her
   * first unit finishes the first seventh. No surah gates, so only the stage exam can hold her back.
   */
  async function classroom(mode: 'OFF' | 'REQUIRED' | 'BLOCKING') {
    const teacher = await newStaff('TEACHER', scopeA);
    const { id: circleId } = (
      await supervisorA.post('/v1/supervisor/circles').send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId: teacher.id, trackId: await trackIdOf(t) }).expect(201)
    ).body as { id: string };
    const reg = await register(t, newPhone(), 'women');
    const { id: studentId } = (await t.http().get('/v1/me').set(bearer(reg.accessToken)).expect(200)).body as { id: string };
    await supervisorA.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId }).expect(204);

    const { body } = await admin
      .post('/v1/admin/tracks')
      .send({ kind: 'MEMORIZATION', name: `مسار ${randomId().slice(0, 6)}`, audience: 'اختبار', durationMonths: 1, memorizationOrder: 'FORWARD', dailyUnit: 'SURAH', wirdDays: [0, 1, 2, 3, 4, 5, 6], consolidationDays: 0 })
      .expect(201);
    const { id: templateId } = body as { id: string };
    await admin.patch(`/v1/admin/gate-rules/tracks/${templateId}`).send({ mode: 'PAUSED' }).expect(204);
    await admin.patch(`/v1/admin/gate-rules/tracks/${templateId}/stage-exam`).send({ mode }).expect(204);
    await t.prisma.studentPlan.update({ where: { studentId }, data: { templateId, surahOrder: [4, 5], completedUnits: 0 } });
    return { teacher, circleId, student: { id: studentId, token: reg.accessToken } };
  }

  const complete = async (token: string) => {
    await nextWirdDay(t, token);
    await finishWirdSteps(t, token);
    return t.http().post('/v1/me/wird/complete').set(bearer(token));
  };
  const examsOf = async (token: string) => (await t.http().get('/v1/me/stage-exams').set(bearer(token)).expect(200)).body as StudentExams;
  const examinerList = async (client: Agent) => ((await client.get('/v1/teacher/stage-exam-sessions').expect(200)).body as { items: ExamSession[] }).items;
  /** Adds the first seventh's first three surahs, each with `mistakes` memorization mistakes, and records the result. */
  const scoreExam = async (client: Agent, sessionId: string, mistakes: number) => {
    const base = `/v1/teacher/stage-exam-sessions/${sessionId}`;
    for (const [surah, toAyah] of [[1, 7], [2, 20], [3, 10]]) {
      const { id } = (await client.post(`${base}/items`).send({ surah, fromAyah: 1, toAyah }).expect(201)).body as { id: string };
      for (let index = 0; index < mistakes; index++) await client.post(`${base}/items/${id}/marks`).send({ kind: 'HIFZ' }).expect(201);
    }
    return (await client.post(`${base}/result`).send({ note: null }).expect(201)).body as { score: number; passed: boolean };
  };
  const settle = (scheduling: 'TEACHER' | 'SUPERVISOR' | 'STUDENT', division: 'SURAHS' | 'PAGES' = 'SURAHS') =>
    admin.put('/v1/admin/settings/stage-exam').send({ division, scheduling }).expect(204);

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
    const scopeB = ((await admin.post('/v1/admin/scopes').send({ name: `ب ${randomId()}` }).expect(201)).body as { id: string }).id;
    supervisorA = (await newStaff('SUPERVISOR', scopeA)).client;
    supervisorB = (await newStaff('SUPERVISOR', scopeB)).client;
  }, 180_000);
  afterAll(async () => {
    // The files share one schema, so the settings go back to their defaults.
    await t.prisma.appSetting.deleteMany({ where: { key: 'stageExam' } });
    await t.app.close();
  });

  it('opens an exam when a seventh is finished, tells the examiner and the supervisor, and holds a blocking track back', async () => {
    await settle('TEACHER');
    const room = await classroom('BLOCKING');
    expect((await complete(room.student.token)).status).toBe(204);

    const [opened] = await examinerList(room.teacher.client);
    expect(opened).toMatchObject({ stage: 1, status: 'WAITING', retake: false, examiner: { id: room.teacher.id } });
    const inScope = (await supervisorA.get('/v1/stage-exams').expect(200)).body as { items: { id: string }[] };
    expect(inScope.items.map(({ id }) => id)).toContain(opened.id);
    const outside = (await supervisorB.get('/v1/stage-exams').expect(200)).body as { items: { id: string }[] };
    expect(outside.items.map(({ id }) => id)).not.toContain(opened.id);

    const notified = await t.prisma.notification.findMany({ where: { dedupeKey: `stage-exam-open:${opened.id}` }, select: { userId: true } });
    expect(notified.map(({ userId }) => userId)).toEqual(expect.arrayContaining([room.student.id, room.teacher.id]));
    expect(notified.length).toBeGreaterThanOrEqual(3);

    // New memorization waits for the exam.
    const held = await complete(room.student.token);
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: 'stage_exam_pending' });
    expect(await examsOf(room.student.token)).toMatchObject({ mode: 'BLOCKING', holdsBack: true });

    // The examiner sets the time, examines, and a failing score opens a retake.
    await room.teacher.client.patch(`/v1/teacher/stage-exam-sessions/${opened.id}/schedule`).send({ scheduledAt: inHours(2) }).expect(200);
    await room.teacher.client.post(`/v1/teacher/stage-exam-sessions/${opened.id}/start`).expect(204);
    await t.http().post(`/v1/me/stage-exams/${opened.id}/voice-ticket`).set(bearer(room.student.token)).expect(200);
    // Three surahs of the first seventh, each with five memorization mistakes: 5 of 10, below the pass score.
    const result = await scoreExam(room.teacher.client, opened.id, 5);
    expect(result).toMatchObject({ score: 5, passed: false });
    await room.teacher.client.post(`/v1/teacher/stage-exam-sessions/${opened.id}/result`).send({}).expect(409);

    const [retake] = await examinerList(room.teacher.client);
    expect(retake).toMatchObject({ stage: 1, status: 'WAITING', retake: true });
    expect((await complete(room.student.token)).status).toBe(409);

    // The supervisor gives the retake to another teacher, of the student's own section only.
    const man = await newStaff('TEACHER', scopeA, 'MEN');
    await supervisorA.put(`/v1/stage-exams/${retake.id}/arrangement`).send({ examinerId: man.id, scheduledAt: null }).expect(409);
    const other = await newStaff('TEACHER', scopeA);
    await supervisorB.put(`/v1/stage-exams/${retake.id}/arrangement`).send({ examinerId: other.id, scheduledAt: null }).expect(404);
    const moved = (await supervisorA.put(`/v1/stage-exams/${retake.id}/arrangement`).send({ examinerId: other.id, scheduledAt: inHours(3) }).expect(200)).body as ExamSession;
    expect(moved).toMatchObject({ status: 'SCHEDULED', examiner: { id: other.id } });
    expect(await examinerList(room.teacher.client)).toHaveLength(0);

    await other.client.post(`/v1/teacher/stage-exam-sessions/${retake.id}/start`).expect(204);
    expect(await scoreExam(other.client, retake.id, 0)).toMatchObject({ score: 10, passed: true });

    const after = await examsOf(room.student.token);
    expect(after).toMatchObject({ holdsBack: false, exams: [] });
    expect(after.history.map(({ passed }) => passed)).toEqual([true, false]);
    expect((await complete(room.student.token)).status).toBe(204);
  }, 240_000);

  it('lets the student book one of the examiner\'s times when the settings say so', async () => {
    await settle('STUDENT');
    const room = await classroom('REQUIRED');
    expect((await complete(room.student.token)).status).toBe(204);
    const [exam] = (await examsOf(room.student.token)).exams;
    expect(exam).toMatchObject({ canBook: true, slots: [] });

    // Only the student picks the time.
    await room.teacher.client.patch(`/v1/teacher/stage-exam-sessions/${exam.id}/schedule`).send({ scheduledAt: inHours(2) }).expect(409);

    const slot = (await room.teacher.client.post('/v1/teacher/admission/slots').send({ startsAt: inHours(5) }).expect(201)).body as { id: string };
    expect((await examsOf(room.student.token)).exams[0].slots.map(({ id }) => id)).toEqual([slot.id]);
    const booked = (await t.http().post(`/v1/me/stage-exams/${exam.id}/book`).set(bearer(room.student.token)).send({ slotId: slot.id }).expect(200)).body as ExamSession;
    expect(booked.status).toBe('SCHEDULED');

    // A booked time is no longer free, for admission tests either, and can't be removed.
    const slots = (await room.teacher.client.get('/v1/teacher/admission/slots').expect(200)).body as { id: string; bookedFor: string | null }[];
    expect(slots.find(({ id }) => id === slot.id)).toMatchObject({ bookedFor: 'STAGE_EXAM' });
    await room.teacher.client.delete(`/v1/teacher/admission/slots/${slot.id}`).expect(409);

    // Not holding back: the next surah goes on.
    expect((await complete(room.student.token)).status).toBe(204);

    // Cancelling frees the time again.
    await supervisorA.post(`/v1/stage-exams/${exam.id}/cancel`).expect(204);
    await room.teacher.client.delete(`/v1/teacher/admission/slots/${slot.id}`).expect(204);
  });

  it('scores each surah from its mistakes, by the settings, and keeps the rules with the result', async () => {
    await admin
      .put('/v1/admin/settings/stage-exam')
      .send({ division: 'SURAHS', scheduling: 'TEACHER', deductions: { HIFZ: 1, PROMPT: 0.5, HESITATION: 0.25, TAJWEED: 0.25 }, minSurahs: 2, passScore: 7 })
      .expect(204);
    const room = await classroom('REQUIRED');
    expect((await complete(room.student.token)).status).toBe(204);
    const [exam] = await examinerList(room.teacher.client);
    const base = `/v1/teacher/stage-exam-sessions/${exam.id}`;

    // Nothing is scored before the exam starts.
    await room.teacher.client.post(`${base}/items`).send({ surah: 1, fromAyah: 1, toAyah: 7 }).expect(409);
    await room.teacher.client.post(`${base}/start`).expect(204);

    // Only the seventh being tested, and only real ayahs.
    expect((await room.teacher.client.post(`${base}/items`).send({ surah: 18, fromAyah: 1, toAyah: 10 }).expect(409)).body).toMatchObject({ code: 'outside_seventh' });
    await room.teacher.client.post(`${base}/items`).send({ surah: 1, fromAyah: 1, toAyah: 8 }).expect(400);

    const fatiha = (await room.teacher.client.post(`${base}/items`).send({ surah: 1, fromAyah: 1, toAyah: 7 }).expect(201)).body as { id: string; score: number };
    expect(fatiha.score).toBe(10);
    await room.teacher.client.post(`${base}/result`).send({}).expect(409);

    const baqarah = (await room.teacher.client.post(`${base}/items`).send({ surah: 2, fromAyah: 1, toAyah: 30 }).expect(201)).body as { id: string };
    for (const kind of ['HIFZ', 'HIFZ', 'PROMPT', 'HESITATION', 'TAJWEED']) {
      await room.teacher.client.post(`${base}/items/${baqarah.id}/marks`).send({ kind, note: 'الآية 5' }).expect(201);
    }
    // A mistake recorded by mistake is undone.
    const extra = (await room.teacher.client.post(`${base}/items/${fatiha.id}/marks`).send({ kind: 'HIFZ' }).expect(201)).body as { id: string };
    await room.teacher.client.delete(`${base}/marks/${extra.id}`).expect(204);

    const sheet = (await room.teacher.client.get(base).expect(200)).body as { items: { score: number; counts: Record<string, number> }[]; running: { score: number } };
    // Al-Baqarah: 10 - 2 - 0.5 - 0.25 - 0.25 = 7. The mean of 10 and 7 is 8.5.
    expect(sheet.items.map(({ score }) => score)).toEqual([10, 7]);
    expect(sheet.items[1].counts).toEqual({ HIFZ: 2, PROMPT: 1, HESITATION: 1, TAJWEED: 1 });
    expect(sheet.running).toMatchObject({ score: 8.5, passed: true });

    // The examiner can't set the score.
    await room.teacher.client.post(`${base}/result`).send({ score: 10 }).expect(400);
    expect((await room.teacher.client.post(`${base}/result`).send({ note: 'أحسنتِ' }).expect(201)).body).toMatchObject({ score: 8.5, passed: true });
    await room.teacher.client.post(`${base}/items`).send({ surah: 3, fromAyah: 1, toAyah: 5 }).expect(409);

    // Changing the settings later leaves the recorded result as it was.
    await settle('TEACHER');
    const kept = (await supervisorA.get(`/v1/stage-exams/${exam.id}`).expect(200)).body as { rules: { minSurahs: number }; items: { score: number }[]; result: { score: number } };
    expect(kept).toMatchObject({ rules: { minSurahs: 2 }, result: { score: 8.5 } });
    const [history] = (await examsOf(room.student.token)).history as unknown as { score: number; note: string; items: { surahName: string; score: number }[] }[];
    expect(history).toMatchObject({ score: 8.5, note: 'أحسنتِ', items: [{ surahName: 'الفاتحة', score: 10 }, { score: 7 }] });
  }, 240_000);

  it('opens nothing on a track without stage exams', async () => {
    await settle('TEACHER');
    const room = await classroom('OFF');
    expect((await complete(room.student.token)).status).toBe(204);
    expect((await complete(room.student.token)).status).toBe(204);
    expect(await examsOf(room.student.token)).toMatchObject({ mode: 'OFF', exams: [] });
  });

  it('settles an open exam when the teacher records a pass by hand', async () => {
    await settle('TEACHER');
    const room = await classroom('BLOCKING');
    expect((await complete(room.student.token)).status).toBe(204);
    await room.teacher.client.post('/v1/teacher/stage-exams').send({ studentId: room.student.id, stage: 1, score: 9 }).expect(201);
    expect(await examsOf(room.student.token)).toMatchObject({ holdsBack: false, exams: [] });
  });
});
