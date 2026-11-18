import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { riyadhDate } from '../src/common/staff-api.js';
import { createTestApp, keepStaffSignedIn, register, type TestApp, trackIdOf } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';
type Agent = ReturnType<typeof request.agent>;

const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;

/** The fixes measured against the functional map: attendance once a day, the wird count, corrections, track changes, skip and rewind. */
describe('teacher and supervisor against the functional map', () => {
  let t: TestApp;
  let admin: Agent;
  let scope: string;
  let supervisor: Agent;
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

  async function newStaff(role: 'TEACHER' | 'SUPERVISOR') {
    const email = uniqueEmail();
    const { body } = await admin.post('/v1/admin/staff').send({ fullName: `${role} اختبار`, email, role, scopeId: scope }).expect(201);
    const created = body as { staff: { id: string }; setupToken: string };
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
    if (role === 'SUPERVISOR') return { id: created.staff.id, client: await enroll(email) };
    const client = agent();
    await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    return { id: created.staff.id, client };
  }

  async function newStudent() {
    const reg = await register(t);
    const { id } = (await t.http().get('/v1/me').set(bearer(reg.accessToken)).expect(200)).body as { id: string };
    return { ...reg, id };
  }

  async function classroom() {
    const teacher = await newStaff('TEACHER');
    const { id: circleId } = (
      await supervisor
        .post('/v1/supervisor/circles')
        .send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId: teacher.id, trackId: await trackIdOf(t) })
        .expect(201)
    ).body as { id: string };
    const student = await newStudent();
    await supervisor.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId: student.id }).expect(204);
    return { teacher, circleId, student };
  }

  const recite = (room: Awaited<ReturnType<typeof classroom>>, attendance = 'PRESENT') =>
    room.teacher.client
      .post('/v1/teacher/recitations')
      .send({ studentId: room.student.id, surah: 67, fromAyah: 1, toAyah: 10, score: attendance === 'ABSENT' ? null : 8, segmentStatus: null, attendance })
      .expect(201);

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
    scope = ((await admin.post('/v1/admin/scopes').send({ name: `أ ${randomId()}` }).expect(201)).body as { id: string }).id;
    supervisor = (await newStaff('SUPERVISOR')).client;
  }, 180_000);
  afterAll(async () => {
    await t.app.close();
  });
  keepStaffSignedIn(() => [admin, supervisor]);

  it('counts a day once, whether attendance came from a recitation, the sheet, or both', async () => {
    const room = await classroom();
    await recite(room);
    await room.teacher.client.post('/v1/teacher/attendance/sheet').send({ entries: [{ studentId: room.student.id, attendance: 'PRESENT' }] }).expect(204);
    await recite(room);

    expect(await t.prisma.evaluation.count({ where: { studentId: room.student.id, attendanceOn: { not: null } } })).toBe(1);
    const profile = (await room.teacher.client.get(`/v1/teacher/students/${room.student.id}`).expect(200)).body as {
      attendance: { present: number; absent: number };
    };
    expect(profile.attendance).toMatchObject({ present: 1, absent: 0 });

    // A later record of the same day is the day's attendance.
    await recite(room, 'ABSENT');
    const after = (await room.teacher.client.get(`/v1/teacher/students/${room.student.id}`).expect(200)).body as {
      attendance: { present: number; absent: number };
    };
    expect(after.attendance).toMatchObject({ present: 0, absent: 1 });
  });

  it('counts on the home page the students who did their own wird today, not the recitations the teacher heard', async () => {
    const room = await classroom();
    await recite(room);
    const home = async () =>
      ((await room.teacher.client.get('/v1/teacher/home').expect(200)).body as { stats: { recordedToday: number } }).stats.recordedToday;
    expect(await home()).toBe(0);

    const plan = await t.prisma.studentPlan.findUniqueOrThrow({ where: { studentId: room.student.id }, select: { id: true } });
    await t.prisma.wirdLog.create({ data: { planId: plan.id, unitIndex: 0, source: 'STUDENT', doneOn: riyadhDate() } });
    expect(await home()).toBe(1);
  });

  it('lets a teacher correct or remove her own recitation only, keeping the day\'s attendance', async () => {
    const room = await classroom();
    const { id } = (await recite(room)).body as { id: string };
    const other = await classroom();

    const corrected = (await room.teacher.client.patch(`/v1/teacher/recitations/${id}`).send({ score: 9.5, note: 'أحسنتِ' }).expect(200))
      .body as { score: number; note: string };
    expect(corrected).toMatchObject({ score: 9.5, note: 'أحسنتِ' });
    await other.teacher.client.patch(`/v1/teacher/recitations/${id}`).send({ score: 1 }).expect(404);
    await other.teacher.client.delete(`/v1/teacher/recitations/${id}`).expect(404);

    await room.teacher.client.delete(`/v1/teacher/recitations/${id}`).expect(204);
    expect(await t.prisma.evaluation.count({ where: { studentId: room.student.id, surah: { not: null } } })).toBe(0);
    expect(await t.prisma.evaluation.count({ where: { studentId: room.student.id, attendanceOn: { not: null } } })).toBe(1);
  });

  it('takes a track change from the student to the teacher, out of the circle, and to the supervisor to place', async () => {
    const room = await classroom();
    const student = bearer(room.student.accessToken);
    const ask = (trackCode: string) => t.http().post('/v1/me/track-change').set(student).send({ trackCode, reason: 'أحتاج وقتًا أطول' });

    await ask('steady').expect(409);
    expect((await ask('advanced').expect(201)).body).toMatchObject({ status: 'PENDING' });
    await ask('stabilization').expect(409);

    const pending = (await room.teacher.client.get('/v1/teacher/track-changes').expect(200)).body as { id: string }[];
    expect(pending).toHaveLength(1);
    const scoped = (await supervisor.get('/v1/supervisor/track-changes').expect(200)).body as { id: string; status: string }[];
    expect(scoped.find(({ id }) => id === pending[0].id)?.status).toBe('PENDING');

    await room.teacher.client.post(`/v1/teacher/track-changes/${pending[0].id}/approve`).expect(204);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: room.student.id }, select: { trackTemplateId: true, trackId: true } });
    expect(user).toEqual({ trackTemplateId: await trackIdOf(t, 'advanced'), trackId: 'ADVANCED' });
    expect(await t.prisma.circleMembership.count({ where: { studentId: room.student.id, leftAt: null } })).toBe(0);
    expect(await t.prisma.studentPlan.count({ where: { studentId: room.student.id } })).toBe(0);

    const placed = (await supervisor.get('/v1/supervisor/track-changes').expect(200)).body as { id: string; awaitingPlacement: boolean }[];
    expect(placed.find(({ id }) => id === pending[0].id)?.awaitingPlacement).toBe(true);
    expect((await t.http().get('/v1/me/track-change').set(student).expect(200)).body).toMatchObject({ status: 'APPROVED' });

    // Without a circle the student changes it herself.
    expect((await ask('steady').expect(201)).body).toEqual({ status: 'APPLIED' });
  });

  it('lets the teacher pass the current surah, or send the student back to an earlier one', async () => {
    const room = await classroom();
    const actions = async () =>
      (await room.teacher.client.get(`/v1/teacher/students/${room.student.id}/plan-actions`).expect(200)).body as {
        currentSurah: { surah: number } | null;
        rewindable: { surah: number }[];
      };
    const before = await actions();
    expect(before.rewindable).toEqual([]);
    const first = before.currentSurah!.surah;

    await room.teacher.client.post(`/v1/teacher/students/${room.student.id}/skip-surah`).expect(204);
    const after = await actions();
    expect(after.currentSurah?.surah).not.toBe(first);
    expect(after.rewindable.map(({ surah }) => surah)).toContain(first);

    await room.teacher.client.post(`/v1/teacher/students/${room.student.id}/rewind`).send({ surah: after.currentSurah!.surah }).expect(409);
    await room.teacher.client.post(`/v1/teacher/students/${room.student.id}/rewind`).send({ surah: first }).expect(204);
    const plan = await t.prisma.studentPlan.findUniqueOrThrow({ where: { studentId: room.student.id }, include: { logs: true } });
    expect(plan.completedUnits).toBe(0);
    expect(plan.logs).toHaveLength(0);
    expect(await t.prisma.surahGate.count({ where: { studentId: room.student.id, surah: first } })).toBe(0);
  });

  it('opens a student\'s file and record to the supervisor of the scope, and filters the gate report by period', async () => {
    const room = await classroom();
    await recite(room);
    const file = (await supervisor.get(`/v1/supervisor/students/${room.student.id}`).expect(200)).body as { circle: { id: string } };
    expect(file.circle.id).toBe(room.circleId);
    const record = (await supervisor.get(`/v1/supervisor/students/${room.student.id}/record`).expect(200)).body as { recitations: unknown[] };
    expect(record.recitations).toHaveLength(1);

    const outsider = await newStudent();
    await supervisor.get(`/v1/supervisor/students/${outsider.id}`).expect(404);
    await supervisor.get('/v1/supervisor/reports/gates?days=30').expect(200);
  });
});
