import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { createTestApp, keepStaffSignedIn, LEAKED_PASSWORD, newPhone, register, type TestApp, trackIdOf } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';

type Agent = ReturnType<typeof request.agent>;
const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;

describe('dashboard', () => {
  let t: TestApp;
  const agent = (): Agent => request.agent(t.app.getHttpServer()).set('Origin', ORIGIN);

  let admin: Agent;
  let adminId: string;
  let scopeA: string;
  let scopeB: string;

  /** Password, then the authenticator, through the real endpoints. */
  async function loginWithEnrollment(email: string): Promise<{ client: Agent; secret: string }> {
    const client = agent();
    const { body } = await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    const { mfaToken } = body as { mfaToken: string };
    const { body: enrollment } = await client.post('/v1/staff/auth/totp/enroll').send({ mfaToken }).expect(200);
    const { secret } = enrollment as { secret: string };
    await client.post('/v1/staff/auth/totp/confirm').send({ mfaToken, code: generateSync({ secret }) }).expect(200);
    return { client, secret };
  }

  async function createStaff(role: 'TEACHER' | 'SUPERVISOR', scopeId: string, email = uniqueEmail()) {
    const { body } = await admin.post('/v1/admin/staff').send({ fullName: `${role} فلانة`, email, role, scopeId }).expect(201);
    const created = body as { staff: { id: string }; setupToken: string };
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);

    if (role === 'SUPERVISOR') return { id: created.staff.id, email, ...(await loginWithEnrollment(email)) };
    const client = agent();
    await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    return { id: created.staff.id, email, client, secret: '' };
  }

  async function newStudentId() {
    const { accessToken } = await register(t);
    const { body } = await t.http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    return (body as { id: string }).id;
  }

  async function createCircle(supervisor: Agent, teacherId: string, capacity = 25, trackId?: string) {
    const { body } = await supervisor
      .post('/v1/supervisor/circles')
      .send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId, capacity, trackId: trackId ?? (await trackIdOf(t)) })
      .expect(201);
    return (body as { id: string }).id;
  }

  /** A supervisor, teacher and circle with one student, in a given scope. */
  async function world(scopeId: string, supervisor?: Agent) {
    const sup = supervisor ?? (await createStaff('SUPERVISOR', scopeId)).client;
    const teacher = await createStaff('TEACHER', scopeId);
    const circleId = await createCircle(sup, teacher.id);
    const studentId = await newStudentId();
    await sup.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId }).expect(204);
    return { supervisor: sup, teacher, circleId, studentId };
  }

  beforeAll(async () => {
    t = await createTestApp();
    const email = uniqueEmail();
    const user = await t.prisma.user.create({
      data: {
        email,
        fullName: 'مديرة الاختبار',
        role: 'ADMIN',
        staffCredential: { create: { passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } },
      },
    });
    adminId = user.id;
    admin = (await loginWithEnrollment(email)).client;
    scopeA = ((await admin.post('/v1/admin/scopes').send({ name: `أ ${randomId()}` }).expect(201)).body as { id: string }).id;
    scopeB = ((await admin.post('/v1/admin/scopes').send({ name: `ب ${randomId()}` }).expect(201)).body as { id: string }).id;
  });
  afterAll(async () => {
    await t.app.close();
  });
  keepStaffSignedIn(() => [admin]);

  describe('signing in', () => {
    it('answers the same for a wrong email, wrong password, suspended account and unset password', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      const suspended = await createStaff('TEACHER', scopeA);
      await admin.patch(`/v1/admin/staff/${suspended.id}`).send({ status: 'SUSPENDED' }).expect(200);
      const { body: fresh } = await admin.post('/v1/admin/staff').send({ fullName: 'بلا كلمة مرور', email: uniqueEmail(), role: 'TEACHER', scopeId: scopeA }).expect(201);
      const unsetEmail = (fresh as { staff: { email: string } }).staff.email;

      const attempt = (identifier: string, password: string) =>
        agent().post('/v1/staff/auth/login').send({ identifier, password }).expect(401);
      const results = await Promise.all([
        attempt(uniqueEmail(), PASSWORD),
        attempt(teacher.email, 'wrong-password-here'),
        attempt(suspended.email, PASSWORD),
        attempt(unsetEmail, PASSWORD),
      ]);
      const codes = new Set(results.map(({ body }) => (body as { code: string }).code));
      expect([...codes]).toEqual(['invalid_credentials']);
    });

    it('locks after 5 wrong passwords, even for the right one, and looks no different', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      for (let attempt = 0; attempt < 5; attempt++) {
        await agent().post('/v1/staff/auth/login').send({ identifier: teacher.email, password: 'wrong-password-here' }).expect(401);
      }
      const { body } = await agent().post('/v1/staff/auth/login').send({ identifier: teacher.email, password: PASSWORD }).expect(401);
      expect(body).toMatchObject({ code: 'invalid_credentials' });
    });

    it('does not let a student sign in, with their phone number', async () => {
      const { phone } = await register(t);
      await agent().post('/v1/staff/auth/login').send({ identifier: phone, password: PASSWORD }).expect(401);
    });

    it('keeps tokens out of the response body, in HttpOnly SameSite=Strict cookies', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      const response = await agent().post('/v1/staff/auth/login').send({ identifier: teacher.email, password: PASSWORD }).expect(200);
      expect(response.body).toEqual({ next: 'done' });
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Strict');
      }
      expect(cookies.find((cookie) => cookie.startsWith('qimam_staff_rt='))).toContain('Path=/v1/staff/auth');
    });

    it('never returns the password hash or authenticator secret', async () => {
      const { text } = await admin.get('/v1/admin/staff').expect(200);
      expect(text).not.toMatch(/argon2|passwordHash|totpSecret/);
      await admin.get('/v1/staff/auth/me').expect(200);
    });
  });

  describe('the second factor', () => {
    it('gives a supervisor no session until the authenticator is confirmed', async () => {
      const { body: created } = await admin.post('/v1/admin/staff').send({ fullName: 'مشرفة جديدة', email: uniqueEmail(), role: 'SUPERVISOR', scopeId: scopeA }).expect(201);
      const { staff, setupToken } = created as { staff: { email: string }; setupToken: string };
      await agent().post('/v1/staff/auth/password/set').send({ token: setupToken, password: PASSWORD }).expect(204);

      const client = agent();
      const response = await client.post('/v1/staff/auth/login').send({ identifier: staff.email, password: PASSWORD }).expect(200);
      expect(response.body).toMatchObject({ next: 'enroll_totp' });
      expect(response.headers['set-cookie']).toBeUndefined();
      await client.get('/v1/staff/auth/me').expect(401);
      await client.get('/v1/supervisor/home').expect(401);
    });

    it('refuses a wrong code, then a used code, and cannot be enrolled twice', async () => {
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      const client = agent();
      const { body } = await client.post('/v1/staff/auth/login').send({ identifier: supervisor.email, password: PASSWORD }).expect(200);
      const { next, mfaToken } = body as { next: string; mfaToken: string };
      expect(next).toBe('totp');

      await client.post('/v1/staff/auth/totp/verify').send({ mfaToken, code: '000000' }).expect(401);
      // The code that confirmed enrollment moments ago.
      await client.post('/v1/staff/auth/totp/verify').send({ mfaToken, code: generateSync({ secret: supervisor.secret }) }).expect(401);
      // A stolen password must not be able to replace the authenticator.
      await client.post('/v1/staff/auth/totp/enroll').send({ mfaToken }).expect(409);
      await client.post('/v1/staff/auth/totp/confirm').send({ mfaToken, code: '000000' }).expect(409);
    });

    it('does not accept the second-step token as a session', async () => {
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      const { body } = await agent().post('/v1/staff/auth/login').send({ identifier: supervisor.email, password: PASSWORD }).expect(200);
      const { mfaToken } = body as { mfaToken: string };
      await t.http().get('/v1/staff/auth/me').set('Cookie', `qimam_staff_at=${mfaToken}`).expect(401);
    });

    it('stores the authenticator secret encrypted', async () => {
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      const row = await t.prisma.staffCredential.findUniqueOrThrow({ where: { userId: supervisor.id } });
      expect(row.totpSecretEncrypted).not.toContain(supervisor.secret);
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    });
  });

  describe('setup links and passwords', () => {
    async function newLink() {
      const email = uniqueEmail();
      const { body } = await admin.post('/v1/admin/staff').send({ fullName: 'نورة العتيبي', email, role: 'TEACHER', scopeId: scopeA }).expect(201);
      return { email, ...(body as { staff: { id: string }; setupToken: string }) };
    }
    const setPassword = (token: string, password: string) => agent().post('/v1/staff/auth/password/set').send({ token, password });

    it('rejects short, personal and breached passwords, without spending the link', async () => {
      const { setupToken, email } = await newLink();
      await setPassword(setupToken, 'short').expect(400);
      expect((await setPassword(setupToken, `${email.split('@')[0]}-extra`).expect(400)).body).toMatchObject({ code: 'weak_password' });
      expect((await setPassword(setupToken, LEAKED_PASSWORD).expect(400)).body).toMatchObject({ code: 'leaked_password' });
      await setPassword(setupToken, PASSWORD).expect(204);
    });

    it('works once, and a new link cancels the old one', async () => {
      const { setupToken, staff } = await newLink();
      const { body } = await admin.post(`/v1/admin/staff/${staff.id}/reset-credentials`).expect(200);
      await setPassword(setupToken, PASSWORD).expect(400);
      const { setupToken: next } = body as { setupToken: string };
      await setPassword(next, PASSWORD).expect(204);
      await setPassword(next, PASSWORD).expect(400);
    });

    it('refuses a used supervisor link, however many tries, and leaves the password alone', async () => {
      const email = uniqueEmail();
      const { body } = await admin.post('/v1/admin/staff').send({ fullName: 'نورة العتيبي', email, role: 'SUPERVISOR', scopeId: scopeA }).expect(201);
      const { setupToken, staff } = body as { staff: { id: string }; setupToken: string };
      await setPassword(setupToken, PASSWORD).expect(204);
      const hashOf = async () => (await t.prisma.staffCredential.findUniqueOrThrow({ where: { userId: staff.id } })).passwordHash;
      const before = await hashOf();

      for (const attempt of ['Another-Strong-Pass-1', 'Another-Strong-Pass-2']) {
        expect((await setPassword(setupToken, attempt).expect(400)).body).toMatchObject({ code: 'invalid_setup_token' });
      }
      expect(await hashOf()).toBe(before);
    });

    it('lets only one of two simultaneous uses of a link through', async () => {
      const { setupToken } = await newLink();
      const results = await Promise.all([setPassword(setupToken, PASSWORD), setPassword(setupToken, `${PASSWORD}-2`)]);
      expect(results.map(({ status }) => status).sort()).toEqual([204, 400]);
    });

    it('stores only a hash of the link', async () => {
      const { setupToken, staff } = await newLink();
      const row = await t.prisma.staffSecurityToken.findFirstOrThrow({ where: { userId: staff.id } });
      expect(JSON.stringify(row)).not.toContain(setupToken);
    });

    it('rejects an expired link', async () => {
      const { setupToken, staff } = await newLink();
      await t.prisma.staffSecurityToken.updateMany({ where: { userId: staff.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await setPassword(setupToken, PASSWORD).expect(400);
    });

    it('signs other devices out on a password change', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      const other = agent();
      await other.post('/v1/staff/auth/login').send({ identifier: teacher.email, password: PASSWORD }).expect(200);

      await teacher.client.post('/v1/staff/auth/password/change').send({ currentPassword: 'wrong-password-here', newPassword: 'Another-Sturdy-4418' }).expect(400);
      await teacher.client.post('/v1/staff/auth/password/change').send({ currentPassword: PASSWORD, newPassword: 'Another-Sturdy-4418' }).expect(204);

      await teacher.client.get('/v1/staff/auth/me').expect(200);
      await other.post('/v1/staff/auth/refresh').expect(401);
    });

    it('ends all access when an administrator resets credentials', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      await admin.post(`/v1/admin/staff/${teacher.id}/reset-credentials`).expect(200);
      await teacher.client.post('/v1/staff/auth/refresh').expect(401);
      await agent().post('/v1/staff/auth/login').send({ identifier: teacher.email, password: PASSWORD }).expect(401);
    });
  });

  describe('sessions', () => {
    it('rotates the refresh cookie, and a reused one ends the session', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      const login = await agent().post('/v1/staff/auth/login').send({ identifier: teacher.email, password: PASSWORD }).expect(200);
      const refreshCookie = (login.headers['set-cookie'] as unknown as string[]).find((cookie) => cookie.startsWith('qimam_staff_rt='))!.split(';')[0];
      const refresh = () => t.http().post('/v1/staff/auth/refresh').set('Origin', ORIGIN).set('Cookie', refreshCookie);

      const first = await refresh().expect(204);
      const nextCookie = (first.headers['set-cookie'] as unknown as string[]).find((cookie) => cookie.startsWith('qimam_staff_rt='))!.split(';')[0];
      await refresh().expect(401);
      await t.http().post('/v1/staff/auth/refresh').set('Origin', ORIGIN).set('Cookie', nextCookie).expect(401);
    });

    it('signs out', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      await teacher.client.post('/v1/staff/auth/logout').expect(204);
      await teacher.client.get('/v1/staff/auth/me').expect(401);
      await teacher.client.post('/v1/staff/auth/refresh').expect(401);
    });

    it('keeps the mobile and dashboard sessions apart', async () => {
      const { accessToken } = await register(t);
      await t.http().get('/v1/staff/auth/me').set('Cookie', `qimam_staff_at=${accessToken}`).expect(401);
      await t.http().get('/v1/teacher/home').set('Authorization', `Bearer ${accessToken}`).expect(401);

      const teacher = await createStaff('TEACHER', scopeA);
      const login = await agent().post('/v1/staff/auth/login').send({ identifier: teacher.email, password: PASSWORD }).expect(200);
      const staffToken = (login.headers['set-cookie'] as unknown as string[]).find((cookie) => cookie.startsWith('qimam_staff_at='))!.split(';')[0].split('=')[1];
      await t.http().get('/v1/me').set('Authorization', `Bearer ${staffToken}`).expect(401);
    });

    it('ends at once when the account is suspended', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      await teacher.client.get('/v1/teacher/home').expect(200);
      await admin.patch(`/v1/admin/staff/${teacher.id}`).send({ status: 'SUSPENDED' }).expect(200);
      await teacher.client.get('/v1/teacher/home').expect(401);
    });
  });

  describe('cross-site protection', () => {
    it.each([
      ['no Origin', undefined],
      ['another site', 'https://evil.example'],
      ['a look-alike', 'http://localhost:3000.evil.example'],
    ])('refuses a change from %s', async (_name, origin) => {
      const call = request(t.app.getHttpServer()).post('/v1/staff/auth/login').send({ identifier: 'a@b.co', password: 'x' });
      if (origin) void call.set('Origin', origin);
      expect((await call.expect(403)).body).toMatchObject({ code: 'origin_not_allowed' });
    });

    it('allows only the listed origin through CORS', async () => {
      const allowed = await t.http().options('/v1/staff/auth/login').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST');
      expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      const denied = await t.http().options('/v1/staff/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not apply to the mobile API, which uses no cookies', async () => {
      await t.http().post('/v1/auth/otp/request').send({ phone: newPhone(), purpose: 'login' }).expect(202);
    });
  });

  describe('roles', () => {
    it('sends every signed-out request away', async () => {
      for (const path of ['/v1/teacher/home', '/v1/supervisor/home', '/v1/admin/staff', '/v1/staff/auth/me']) {
        await t.http().get(path).expect(401);
      }
    });

    it('keeps each role to its own routes', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      const supervisor = await createStaff('SUPERVISOR', scopeA);

      await teacher.client.get('/v1/supervisor/home').expect(403);
      await teacher.client.get('/v1/admin/staff').expect(403);
      await teacher.client.post('/v1/admin/scopes').send({ name: 'x' }).expect(403);
      await supervisor.client.get('/v1/teacher/home').expect(403);
      await supervisor.client.get('/v1/admin/staff').expect(403);
      await supervisor.client.post('/v1/admin/staff').send({ fullName: 'x', email: uniqueEmail(), role: 'ADMIN' }).expect(403);
      await admin.get('/v1/teacher/home').expect(403);
      await admin.get('/v1/supervisor/home').expect(403);
    });

    it('rejects extra fields, so nobody can set a role or a password through them', async () => {
      await admin.post('/v1/admin/staff').send({ fullName: 'x', email: uniqueEmail(), role: 'TEACHER', scopeId: scopeA, passwordHash: 'x' }).expect(400);
      await admin.patch(`/v1/admin/staff/${randomId()}`).send({ role: 'ADMIN' }).expect(400);
      await admin.post('/v1/admin/staff').send({ fullName: 'x', email: uniqueEmail(), role: 'STUDENT', scopeId: scopeA }).expect(400);
    });

    it('stops an administrator from suspending or resetting themselves', async () => {
      await admin.patch(`/v1/admin/staff/${adminId}`).send({ status: 'SUSPENDED' }).expect(409);
      await admin.post(`/v1/admin/staff/${adminId}/reset-credentials`).expect(409);
    });

    it('rejects a malformed id before it reaches the database', async () => {
      await admin.patch("/v1/admin/staff/' OR 1=1 --").send({ fullName: 'x' }).expect(400);
    });
  });

  describe('managing staff accounts', () => {
    it('finds accounts by name, email or phone, and by status and scope', async () => {
      const name = `بحث ${randomId().slice(0, 8)}`;
      const email = uniqueEmail();
      const { body } = await admin.post('/v1/admin/staff').send({ fullName: name, email, role: 'TEACHER', scopeId: scopeB }).expect(201);
      const { id } = (body as { staff: { id: string } }).staff;
      const ids = async (query: string) =>
        ((await admin.get(`/v1/admin/staff?${query}`).expect(200)).body as { items: { id: string }[] }).items.map((row) => row.id);

      expect(await ids(`search=${encodeURIComponent(name)}`)).toEqual([id]);
      expect(await ids(`search=${encodeURIComponent(email.toUpperCase())}`)).toEqual([id]);
      expect(await ids(`search=${encodeURIComponent(name)}&scopeId=${scopeA}`)).toEqual([]);
      expect(await ids(`search=${encodeURIComponent(name)}&status=SUSPENDED`)).toEqual([]);
      await admin.patch(`/v1/admin/staff/${id}`).send({ status: 'SUSPENDED' }).expect(200);
      expect(await ids(`search=${encodeURIComponent(name)}&status=SUSPENDED`)).toEqual([id]);
    });

    it('turns a teacher without a circle into a supervisor, and ends her sessions', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      const { body } = await admin.patch(`/v1/admin/staff/${teacher.id}`).send({ role: 'SUPERVISOR' }).expect(200);
      expect(body).toMatchObject({ role: 'SUPERVISOR' });
      // Her teacher session never passed the second step a supervisor needs.
      await teacher.client.get('/v1/supervisor/home').expect(401);
      await teacher.client.get('/v1/teacher/home').expect(401);
      await admin.get(`/v1/admin/supervisors/${teacher.id}`).expect(200);
      await admin.patch(`/v1/admin/staff/${teacher.id}`).send({ role: 'TEACHER' }).expect(200);
    });

    it('keeps a teacher with a circle from changing role or being deleted', async () => {
      const { teacher } = await world(scopeA);
      await admin.patch(`/v1/admin/staff/${teacher.id}`).send({ role: 'SUPERVISOR' }).expect(409);
      await admin.delete(`/v1/admin/staff/${teacher.id}`).expect(409);
    });

    it('clears one way in, but never both', async () => {
      const { body } = await admin
        .post('/v1/admin/staff')
        .send({ fullName: 'بريد وجوال', email: uniqueEmail(), phone: newPhone(), role: 'TEACHER', scopeId: scopeA })
        .expect(201);
      const { id } = (body as { staff: { id: string } }).staff;
      const { body: updated } = await admin.patch(`/v1/admin/staff/${id}`).send({ email: null }).expect(200);
      expect(updated).toMatchObject({ email: null });
      await admin.patch(`/v1/admin/staff/${id}`).send({ phone: null }).expect(400);
    });

    it('deletes an account, but not its own or an administrator', async () => {
      const teacher = await createStaff('TEACHER', scopeA);
      await admin.delete(`/v1/admin/staff/${teacher.id}`).expect(204);
      await admin.get(`/v1/admin/teachers/${teacher.id}`).expect(404);
      await teacher.client.get('/v1/teacher/home').expect(401);
      await admin.delete(`/v1/admin/staff/${adminId}`).expect(409);
      await admin.patch(`/v1/admin/staff/${adminId}`).send({ role: 'TEACHER' }).expect(409);
    });
  });

  describe('a teacher only reaches their own students', () => {
    let mine: Awaited<ReturnType<typeof world>>;
    let other: Awaited<ReturnType<typeof world>>;
    const EVALUATION = { surah: 18, fromAyah: 1, toAyah: 10, score: 9, segmentStatus: 'MASTERED', attendance: 'PRESENT' };

    beforeAll(async () => {
      mine = await world(scopeA);
      other = await world(scopeA, mine.supervisor);
    });

    it('finds only their circle in lists', async () => {
      const { body } = await mine.teacher.client.get('/v1/teacher/students').expect(200);
      const { total, items } = body as { total: number; items: { id: string }[] };
      expect(total).toBe(1);
      expect(items[0].id).toBe(mine.studentId);
    });

    it('answers 404 for another teacher\'s student, for every action', async () => {
      const client = mine.teacher.client;
      const id = other.studentId;
      await client.get(`/v1/teacher/students/${id}`).expect(404);
      await client.post('/v1/teacher/recitations').send({ studentId: id, ...EVALUATION }).expect(404);
      await client.post('/v1/teacher/tasks').send({ title: 'x', studentId: id, recurrence: 'DAILY' }).expect(404);
      await client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'x', studentId: id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() }).expect(404);
    });

    it('answers 404 for another teacher\'s circle, task and session', async () => {
      const task = (await other.teacher.client.post('/v1/teacher/tasks').send({ title: 'x', recurrence: 'DAILY' }).expect(201)).body as { id: string };
      const session = (await other.teacher.client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'x', studentId: other.studentId, scheduledAt: new Date(Date.now() + 3600_000).toISOString() }).expect(201)).body as { id: string };

      const client = mine.teacher.client;
      await client.post('/v1/teacher/tasks').send({ title: 'x', circleId: other.circleId, recurrence: 'DAILY' }).expect(404);
      await client.delete(`/v1/teacher/tasks/${task.id}`).expect(404);
      await client.get(`/v1/teacher/sessions/${session.id}`).expect(404);
      await client.post(`/v1/teacher/sessions/${session.id}/start`).expect(404);
      await client.post(`/v1/teacher/sessions/${session.id}/cancel`).expect(404);
    });

    it('shows no phone number or age', async () => {
      const { text } = await mine.teacher.client.get(`/v1/teacher/students/${mine.studentId}`).expect(200);
      expect(text).not.toMatch(/phone|ageBand|\+966/);
    });
  });

  describe('recording recitations', () => {
    let w: Awaited<ReturnType<typeof world>>;
    const base = { surah: 18, fromAyah: 1, toAyah: 10, score: 9, segmentStatus: 'MASTERED', attendance: 'PRESENT' };
    const record = (body: object) => w.teacher.client.post('/v1/teacher/recitations').send(body);

    beforeAll(async () => {
      w = await world(scopeA);
    });

    it('saves and counts it', async () => {
      const { body } = await record({ studentId: w.studentId, ...base }).expect(201);
      expect(body).toMatchObject({ title: 'الكهف · 1-10', score: 9, maxScore: 10, attendance: 'PRESENT' });

      const home = (await w.teacher.client.get('/v1/teacher/home').expect(200)).body as { stats: { recordedToday: number; notRecorded: number } };
      expect(home.stats).toMatchObject({ recordedToday: 1, notRecorded: 0 });
      const report = (await w.teacher.client.get('/v1/teacher/reports').expect(200)).body as { rows: { attendanceRate: number; averageScore: number }[] };
      expect(report.rows[0]).toMatchObject({ attendanceRate: 100, averageScore: 9 });
    });

    it.each([
      ['an ayah past the end of the surah', { toAyah: 111 }],
      ['a range running backwards', { fromAyah: 10, toAyah: 5 }],
      ['a score over the maximum', { score: 11 }],
      ['a surah that does not exist', { surah: 115 }],
      ['a score for an absent student', { attendance: 'ABSENT' }],
      ['no score for a present student', { score: null }],
      ['an extra field', { teacherId: 'x' }],
    ])('rejects %s', async (_name, change) => {
      await record({ studentId: w.studentId, ...base, ...change }).expect(400);
    });

    it('records an absence with no score', async () => {
      const { body } = await record({ studentId: w.studentId, ...base, score: null, segmentStatus: null, attendance: 'ABSENT' }).expect(201);
      expect(body).toMatchObject({ score: null, attendance: 'ABSENT' });
    });

    it('keeps names and notes out of the audit log, and shows the supervisor the activity', async () => {
      await record({ studentId: w.studentId, ...base, note: 'ملاحظة خاصة' }).expect(201);
      const student = await t.prisma.user.findUniqueOrThrow({ where: { id: w.studentId } });
      const logs = await t.prisma.auditLog.findMany({ where: { actorId: w.teacher.id } });
      expect(JSON.stringify(logs)).not.toContain(student.fullName);
      expect(JSON.stringify(logs)).not.toContain('ملاحظة خاصة');
      expect(JSON.stringify(logs)).not.toContain(student.phone);

      const { body } = await w.supervisor.get(`/v1/supervisor/teachers/${w.teacher.id}/activity`).expect(200);
      expect((body as object[])[0]).toMatchObject({ kind: 'note', studentName: student.fullName, surahName: 'الكهف' });
    });
  });

  describe('tasks', () => {
    it('counts the circle, or one student, and reports status', async () => {
      const w = await world(scopeA);
      const client = w.teacher.client;
      await client.post('/v1/teacher/tasks').send({ title: 'للحلقة', recurrence: 'DAILY', deadlineMinutes: 1439 }).expect(201);
      await client.post('/v1/teacher/tasks').send({ title: 'لطالبة', studentId: w.studentId, recurrence: 'ONCE', dueAt: new Date(Date.now() - 1000).toISOString() }).expect(201);

      const all = (await client.get('/v1/teacher/tasks').expect(200)).body as { title: string; total: number; completed: number; status: string }[];
      expect(all.find(({ title }) => title === 'للحلقة')).toMatchObject({ total: 1, completed: 0, status: 'ongoing' });
      expect(all.find(({ title }) => title === 'لطالبة')).toMatchObject({ total: 1, status: 'overdue' });

      const overdue = (await client.get('/v1/teacher/tasks?status=overdue').expect(200)).body as object[];
      expect(overdue).toHaveLength(1);
    });

    it('hides an archived task', async () => {
      const w = await world(scopeA);
      const { id } = (await w.teacher.client.post('/v1/teacher/tasks').send({ title: 'x', recurrence: 'DAILY' }).expect(201)).body as { id: string };
      await w.teacher.client.delete(`/v1/teacher/tasks/${id}`).expect(204);
      await w.teacher.client.delete(`/v1/teacher/tasks/${id}`).expect(404);
      expect((await w.teacher.client.get('/v1/teacher/tasks').expect(200)).body).toEqual([]);
    });

    it.each([
      ['a one-time task with no date', { recurrence: 'ONCE' }],
      ['a daily task with a date', { recurrence: 'DAILY', dueAt: new Date().toISOString() }],
      ['an impossible deadline', { recurrence: 'DAILY', deadlineMinutes: 1440 }],
    ])('rejects %s', async (_name, change) => {
      const w = await world(scopeA);
      await w.teacher.client.post('/v1/teacher/tasks').send({ title: 'x', ...change }).expect(400);
    });
  });

  describe('session lifecycle', () => {
    const evaluation = { surah: 67, fromAyah: 1, toAyah: 30, score: 8, segmentStatus: 'NEEDS_REVIEW', attendance: 'PRESENT' };

    async function completedSession(w: Awaited<ReturnType<typeof world>>) {
      const { id } = (await w.teacher.client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'الملك', studentId: w.studentId, scheduledAt: new Date(Date.now() + 60_000).toISOString() }).expect(201)).body as { id: string };
      await w.teacher.client.post(`/v1/teacher/sessions/${id}/start`).expect(200);
      await w.teacher.client.post(`/v1/teacher/sessions/${id}/end`).expect(200);
      return id;
    }

    it('moves through its states and refuses to skip any', async () => {
      const w = await world(scopeA);
      const client = w.teacher.client;
      const { id } = (await client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'الملك', studentId: w.studentId, scheduledAt: new Date(Date.now() + 60_000).toISOString() }).expect(201)).body as { id: string };

      await client.post(`/v1/teacher/sessions/${id}/end`).expect(409);
      await client.post(`/v1/teacher/sessions/${id}/evaluation`).send(evaluation).expect(409);
      await client.post(`/v1/teacher/sessions/${id}/start`).expect(200);
      await client.post(`/v1/teacher/sessions/${id}/start`).expect(409);
      await client.post(`/v1/teacher/sessions/${id}/cancel`).expect(409);
      await client.post(`/v1/teacher/sessions/${id}/end`).expect(200);

      const { body } = await client.get(`/v1/teacher/sessions/${id}`).expect(200);
      expect(body).toMatchObject({ status: 'COMPLETED', evaluated: false });
    });

    it('takes one evaluation, even from simultaneous requests', async () => {
      const w = await world(scopeA);
      const id = await completedSession(w);
      const results = await Promise.all([
        w.teacher.client.post(`/v1/teacher/sessions/${id}/evaluation`).send(evaluation),
        w.teacher.client.post(`/v1/teacher/sessions/${id}/evaluation`).send(evaluation),
      ]);
      expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect((await w.teacher.client.get(`/v1/teacher/sessions/${id}`).expect(200)).body).toMatchObject({ evaluated: true, attendance: 'PRESENT' });
    });

    it('needs a student for a recitation session, and allows a whole-circle correction', async () => {
      const w = await world(scopeA);
      const scheduledAt = new Date(Date.now() + 60_000).toISOString();
      await w.teacher.client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'x', scheduledAt }).expect(400);

      const { id, student } = (await w.teacher.client.post('/v1/teacher/sessions').send({ kind: 'CORRECTION', title: 'المدود', scheduledAt }).expect(201)).body as { id: string; student: null };
      expect(student).toBeNull();
      await w.teacher.client.post(`/v1/teacher/sessions/${id}/notes`).send({ notes: 'مبكر' }).expect(409);
      await w.teacher.client.post(`/v1/teacher/sessions/${id}/start`).expect(200);
      await w.teacher.client.post(`/v1/teacher/sessions/${id}/end`).expect(200);
      expect((await w.teacher.client.post(`/v1/teacher/sessions/${id}/notes`).send({ notes: 'تحسن واضح' }).expect(200)).body).toMatchObject({ notes: 'تحسن واضح' });
    });

    it('rejects a date in the past', async () => {
      const w = await world(scopeA);
      await w.teacher.client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'x', studentId: w.studentId, scheduledAt: '2020-01-01T00:00:00Z' }).expect(400);
    });
  });

  describe('a supervisor only reaches their own scope', () => {
    let a: Awaited<ReturnType<typeof world>>;
    let b: Awaited<ReturnType<typeof world>>;

    beforeAll(async () => {
      a = await world(scopeA);
      b = await world(scopeB);
    });

    it('lists only their circles and teachers', async () => {
      const circles = (await a.supervisor.get('/v1/supervisor/circles').expect(200)).body as { id: string }[];
      expect(circles.map(({ id }) => id)).toContain(a.circleId);
      expect(circles.map(({ id }) => id)).not.toContain(b.circleId);
      const teachers = (await a.supervisor.get('/v1/supervisor/teachers').expect(200)).body as { id: string }[];
      expect(teachers.map(({ id }) => id)).not.toContain(b.teacher.id);
      const distribution = (await a.supervisor.get('/v1/supervisor/distribution').expect(200)).body as { circles: { id: string }[] };
      expect(distribution.circles.map(({ id }) => id)).not.toContain(b.circleId);
    });

    it('answers 404 for anything in another scope', async () => {
      const client = a.supervisor;
      const studentId = await newStudentId();
      await client.patch(`/v1/supervisor/circles/${b.circleId}`).send({ name: 'x' }).expect(404);
      await client.delete(`/v1/supervisor/circles/${b.circleId}`).expect(404);
      await client.post(`/v1/supervisor/circles/${b.circleId}/students`).send({ studentId }).expect(404);
      await client.get(`/v1/supervisor/teachers/${b.teacher.id}/activity`).expect(404);
      await client.post('/v1/supervisor/circles').send({ name: 'x', teacherId: b.teacher.id, trackId: await trackIdOf(t) }).expect(404);
      await client.post('/v1/supervisor/transfers').send({ studentId: b.studentId, toCircleId: a.circleId }).expect(404);
      await client.post('/v1/supervisor/transfers').send({ studentId: a.studentId, toCircleId: b.circleId }).expect(404);
      await client.post('/v1/supervisor/announcements').send({ audience: 'CIRCLE', circleId: b.circleId, title: 'x', body: 'x' }).expect(404);
    });

    it('sees no contact details of unassigned students', async () => {
      await newStudentId();
      const { text } = await a.supervisor.get('/v1/supervisor/distribution').expect(200);
      expect(text).not.toMatch(/phone|\+966|ageBand/);
    });

    it('cannot read or edit a teacher in another scope', async () => {
      await a.supervisor.get(`/v1/supervisor/teachers/${b.teacher.id}`).expect(404);
      await a.supervisor.patch(`/v1/supervisor/teachers/${b.teacher.id}`).send({ fullName: 'x' }).expect(404);
    });

    it('sees nothing with no scope set', async () => {
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      await t.prisma.user.update({ where: { id: supervisor.id }, data: { scopeId: null } });
      expect((await supervisor.client.get('/v1/supervisor/circles').expect(403)).body).toMatchObject({ code: 'no_scope' });
    });
  });

  describe('circles and assignment', () => {
    it('opens and edits a teacher in her scope, but not her sign-in email', async () => {
      const w = await world(scopeA);
      const { body } = await w.supervisor.get(`/v1/supervisor/teachers/${w.teacher.id}`).expect(200);
      expect(body).toMatchObject({ account: { id: w.teacher.id }, circles: [{ id: w.circleId, students: 1 }], students: [{ id: w.studentId }] });
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|totp/i);

      await w.supervisor.patch(`/v1/supervisor/teachers/${w.teacher.id}`).send({ fullName: 'اسم جديد' }).expect(204);
      await w.supervisor.patch(`/v1/supervisor/teachers/${w.teacher.id}`).send({ email: uniqueEmail() }).expect(400);
      const { body: after } = await w.supervisor.get(`/v1/supervisor/teachers/${w.teacher.id}`).expect(200);
      expect(after).toMatchObject({ account: { name: 'اسم جديد', email: w.teacher.email } });
    });

    it('replaces a teacher, ending the upcoming sessions of the previous one', async () => {
      const w = await world(scopeA);
      const next = await createStaff('TEACHER', scopeA);
      const session = await t.prisma.liveSession.create({
        data: { circleId: w.circleId, teacherId: w.teacher.id, title: 'جلسة قادمة', scheduledAt: new Date(Date.now() + 86_400_000) },
        select: { id: true },
      });

      await w.supervisor.patch(`/v1/supervisor/circles/${w.circleId}`).send({ teacherId: next.id }).expect(204);
      expect(await t.prisma.liveSession.findUnique({ where: { id: session.id }, select: { status: true } })).toEqual({ status: 'CANCELLED' });
    });

    it('frees a teacher for another circle, and a circle without one takes no transfer', async () => {
      const w = await world(scopeA);
      const other = await world(scopeA, w.supervisor);
      await w.supervisor.patch(`/v1/supervisor/circles/${other.circleId}`).send({ teacherId: null }).expect(204);
      await w.supervisor.post('/v1/supervisor/circles').send({ name: 'جديدة', teacherId: other.teacher.id, trackId: await trackIdOf(t) }).expect(201);

      const { body } = await w.supervisor.post('/v1/supervisor/transfers').send({ studentId: w.studentId, toCircleId: other.circleId }).expect(409);
      expect(body).toMatchObject({ code: 'circle_has_no_teacher' });
    });

    it('lists every student awaiting a circle, past the old limit of 100', async () => {
      const w = await world(scopeA);
      const trackId = await trackIdOf(t);
      const waiting = Array.from({ length: 105 }, (_, index) => ({ id: randomId(), fullName: `منتظرة ${index}`, phone: `+1555${String(index).padStart(7, '0')}`, trackTemplateId: trackId }));
      await t.prisma.user.createMany({ data: waiting });

      const { body } = await w.supervisor.get('/v1/supervisor/distribution').expect(200);
      const listed = new Set((body as { unassigned: { id: string }[] }).unassigned.map(({ id }) => id));
      expect(waiting.every(({ id }) => listed.has(id))).toBe(true);
    });

    it('gives each teacher one circle', async () => {
      const w = await world(scopeA);
      await w.supervisor.post('/v1/supervisor/circles').send({ name: 'ثانية', teacherId: w.teacher.id, trackId: await trackIdOf(t) }).expect(409);
    });

    it('protects a circle that has students', async () => {
      const w = await world(scopeA);
      await w.supervisor.patch(`/v1/supervisor/circles/${w.circleId}`).send({ capacity: 2 }).expect(204);
      await w.supervisor.delete(`/v1/supervisor/circles/${w.circleId}`).expect(409);
    });

    it('fills the last seat once, whatever arrives together', async () => {
      const supervisor = (await createStaff('SUPERVISOR', scopeA)).client;
      const teacher = await createStaff('TEACHER', scopeA);
      const circleId = await createCircle(supervisor, teacher.id, 1);
      const [first, second] = await Promise.all([newStudentId(), newStudentId()]);

      const results = await Promise.all([first, second].map((studentId) => supervisor.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId })));
      expect(results.map(({ status }) => status).sort()).toEqual([204, 409]);
      expect(await t.prisma.circleMembership.count({ where: { circleId, leftAt: null } })).toBe(1);
    });

    it('puts a student in one circle, whatever arrives together', async () => {
      const a = await world(scopeA);
      const b = await world(scopeA, a.supervisor);
      const studentId = await newStudentId();
      const results = await Promise.all([a.circleId, b.circleId].map((id) => a.supervisor.post(`/v1/supervisor/circles/${id}/students`).send({ studentId })));
      expect(results.map(({ status }) => status).sort()).toEqual([204, 409]);
    });

    it('does not assign a staff member as a student', async () => {
      const w = await world(scopeA);
      await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId: w.teacher.id }).expect(404);
    });
  });

  describe('a circle belongs to one track', () => {
    const otherTrack = () => trackIdOf(t, 'advanced');

    it('needs an open track to be created', async () => {
      const supervisor = (await createStaff('SUPERVISOR', scopeA)).client;
      const teacher = await createStaff('TEACHER', scopeA);
      const name = 'حلقة';
      await supervisor.post('/v1/supervisor/circles').send({ name, teacherId: teacher.id }).expect(400);
      await supervisor.post('/v1/supervisor/circles').send({ name, teacherId: teacher.id, trackId: randomId() }).expect(400);
      await admin.post('/v1/admin/circles').send({ name, scopeId: scopeA }).expect(400);
      await supervisor.post('/v1/supervisor/circles').send({ name, teacherId: teacher.id, trackId: await otherTrack() }).expect(201);
    });

    it('allows several circles on one track', async () => {
      const a = await world(scopeA);
      const b = await world(scopeA, a.supervisor);
      const { circles } = (await a.supervisor.get('/v1/supervisor/distribution').expect(200)).body as { circles: { id: string; track: { id: string } | null }[] };
      const track = await trackIdOf(t);
      expect(circles.find(({ id }) => id === a.circleId)?.track?.id).toBe(track);
      expect(circles.find(({ id }) => id === b.circleId)?.track?.id).toBe(track);
    });

    it('takes only students on its track, by assignment or transfer', async () => {
      const w = await world(scopeA);
      const teacher = await createStaff('TEACHER', scopeA);
      const other = await createCircle(w.supervisor, teacher.id, 25, await otherTrack());

      const refused = await w.supervisor.post(`/v1/supervisor/circles/${other}/students`).send({ studentId: await newStudentId() }).expect(409);
      expect(refused.body).toMatchObject({ code: 'track_mismatch' });
      expect((await w.supervisor.post('/v1/supervisor/transfers').send({ studentId: w.studentId, toCircleId: other }).expect(409)).body).toMatchObject({ code: 'track_mismatch' });
      expect((await admin.post(`/v1/admin/circles/${other}/students`).send({ studentId: await newStudentId() }).expect(409)).body).toMatchObject({ code: 'track_mismatch' });
      expect((await admin.post('/v1/admin/transfers').send({ studentId: w.studentId, toCircleId: other }).expect(409)).body).toMatchObject({ code: 'track_mismatch' });
    });

    it('takes nobody until a circle from before this rule has a track', async () => {
      const w = await world(scopeA);
      await t.prisma.circle.update({ where: { id: w.circleId }, data: { trackTemplateId: null } });
      const { body } = await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId: await newStudentId() }).expect(409);
      expect(body).toMatchObject({ code: 'circle_has_no_track' });
    });

    it('keeps its track while a student on it remains', async () => {
      const w = await world(scopeA);
      const refused = await w.supervisor.patch(`/v1/supervisor/circles/${w.circleId}/track`).send({ trackId: await otherTrack() }).expect(409);
      expect(refused.body).toMatchObject({ code: 'circle_has_other_track' });
      await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ trackId: await otherTrack() }).expect(409);
      await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ trackId: null }).expect(400);

      await w.supervisor.delete(`/v1/supervisor/circles/${w.circleId}/students/${w.studentId}`).expect(204);
      await w.supervisor.patch(`/v1/supervisor/circles/${w.circleId}/track`).send({ trackId: await otherTrack() }).expect(204);
    });

    it('keeps its track while a transfer on another is on its way', async () => {
      const from = await world(scopeA);
      const to = await world(scopeA, from.supervisor);
      await from.supervisor.post('/v1/supervisor/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);
      await to.supervisor.delete(`/v1/supervisor/circles/${to.circleId}/students/${to.studentId}`).expect(204);
      await to.supervisor.patch(`/v1/supervisor/circles/${to.circleId}/track`).send({ trackId: await otherTrack() }).expect(409);
    });

    it('holds a student to her circle\'s track', async () => {
      const { accessToken } = await register(t);
      const http = () => t.http().patch('/v1/me').set('Authorization', `Bearer ${accessToken}`);
      const { body: me } = await t.http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
      const w = await world(scopeA);
      await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId: (me as { id: string }).id }).expect(204);
      const { body } = await http().send({ track: { trackId: 'advanced', trackStart: null } }).expect(409);
      expect(body).toMatchObject({ code: 'track_set_by_circle' });
    });

    it('ignores age when placing a student', async () => {
      const w = await world(scopeA);
      const studentId = await newStudentId();
      await t.prisma.user.update({ where: { id: studentId }, data: { ageBand: '60' } });
      await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId }).expect(204);
    });
  });

  describe('editing the distribution', () => {
    type Board = { circles: { id: string; students: { id: string }[] }[]; unassigned: { id: string }[]; transfers: { student: { id: string } }[] };
    const board = async (supervisor: Agent) => (await supervisor.get('/v1/supervisor/distribution').expect(200)).body as Board;

    it('returns a removed student to awaiting assignment and closes what waited on her', async () => {
      const from = await world(scopeA);
      const to = await world(scopeA, from.supervisor);
      await from.supervisor.post('/v1/supervisor/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);

      await from.supervisor.delete(`/v1/supervisor/circles/${from.circleId}/students/${from.studentId}`).expect(204);

      const after = await board(from.supervisor);
      expect(after.circles.find(({ id }) => id === from.circleId)?.students).toEqual([]);
      expect(after.unassigned.map(({ id }) => id)).toContain(from.studentId);
      expect(after.transfers.map(({ student }) => student.id)).not.toContain(from.studentId);
      await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(404);
      await from.supervisor.delete(`/v1/supervisor/circles/${from.circleId}/students/${from.studentId}`).expect(404);
    });

    it('changes nothing when the student is not in that circle', async () => {
      const from = await world(scopeA);
      const to = await world(scopeA, from.supervisor);
      await from.supervisor.post('/v1/supervisor/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);

      await from.supervisor.delete(`/v1/supervisor/circles/${to.circleId}/students/${from.studentId}`).expect(404);

      expect((await board(from.supervisor)).transfers.map(({ student }) => student.id)).toContain(from.studentId);
    });

    it('keeps a transfer open in another scope when a supervisor names her student', async () => {
      const mine = await world(scopeA);
      const from = await world(scopeB);
      const to = await world(scopeB, from.supervisor);
      await from.supervisor.post('/v1/supervisor/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);

      await mine.supervisor.delete(`/v1/supervisor/circles/${mine.circleId}/students/${from.studentId}`).expect(404);
      await mine.supervisor.delete(`/v1/supervisor/circles/${from.circleId}/students/${from.studentId}`).expect(404);

      expect((await board(from.supervisor)).transfers.map(({ student }) => student.id)).toContain(from.studentId);
    });

    it('keeps the order of students, and puts a new one last', async () => {
      const w = await world(scopeA);
      const second = await newStudentId();
      await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId: second }).expect(204);

      await w.supervisor.put(`/v1/supervisor/circles/${w.circleId}/students/order`).send({ studentIds: [second, w.studentId] }).expect(204);
      const third = await newStudentId();
      await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId: third }).expect(204);

      const circle = (await board(w.supervisor)).circles.find(({ id }) => id === w.circleId);
      expect(circle?.students.map(({ id }) => id)).toEqual([second, w.studentId, third]);
    });

    it('keeps the order of circles, and puts a new one last', async () => {
      const scope = ((await admin.post('/v1/admin/scopes').send({ name: `ت ${randomId()}` }).expect(201)).body as { id: string }).id;
      const first = await world(scope);
      const second = await world(scope, first.supervisor);

      await first.supervisor.put('/v1/supervisor/circles/order').send({ circleIds: [second.circleId, first.circleId] }).expect(204);
      const third = await world(scope, first.supervisor);

      const { circles } = await board(first.supervisor);
      expect(circles.map(({ id }) => id)).toEqual([second.circleId, first.circleId, third.circleId]);
    });

    it('refuses an order built from an out-of-date list', async () => {
      const w = await world(scopeA);
      const other = await newStudentId();
      const stale = await w.supervisor.put(`/v1/supervisor/circles/${w.circleId}/students/order`).send({ studentIds: [other] }).expect(409);
      expect(stale.body).toMatchObject({ code: 'order_out_of_date' });
      await w.supervisor.put(`/v1/supervisor/circles/${w.circleId}/students/order`).send({ studentIds: [w.studentId, w.studentId] }).expect(400);
    });

    it('reorders nothing in another scope', async () => {
      const a = await world(scopeA);
      const b = await world(scopeB);
      await a.supervisor.put(`/v1/supervisor/circles/${b.circleId}/students/order`).send({ studentIds: [b.studentId] }).expect(404);
      await a.supervisor.put('/v1/supervisor/circles/order').send({ circleIds: [b.circleId] }).expect(409);
    });
  });

  describe('transfers', () => {
    async function pair() {
      const from = await world(scopeA);
      const to = await world(scopeA, from.supervisor);
      return { from, to };
    }
    const request_ = (w: Awaited<ReturnType<typeof world>>, toCircleId: string) =>
      w.supervisor.post('/v1/supervisor/transfers').send({ studentId: w.studentId, toCircleId });

    it('goes supervisor, then administration, then new teacher, and moves access with it', async () => {
      const { from, to } = await pair();
      const { id } = (await request_(from, to.circleId).expect(201)).body as { id: string };

      // Nobody can skip a step.
      await to.teacher.client.post(`/v1/teacher/transfers/${id}/accept`).expect(404);
      expect((await to.teacher.client.get('/v1/teacher/transfers').expect(200)).body).toEqual([]);

      await admin.post(`/v1/admin/transfers/${id}/approve`).expect(204);
      await admin.post(`/v1/admin/transfers/${id}/approve`).expect(404);
      await from.teacher.client.post(`/v1/teacher/transfers/${id}/accept`).expect(404);
      // The record stays closed until the new teacher accepts.
      await to.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(404);
      await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(200);

      await to.teacher.client.post(`/v1/teacher/transfers/${id}/accept`).expect(204);

      await to.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(200);
      await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(404);
      expect(await t.prisma.circleMembership.count({ where: { studentId: from.studentId, leftAt: null } })).toBe(1);
    });

    it('allows one open transfer per student, and a new one after cancelling', async () => {
      const { from, to } = await pair();
      const { id } = (await request_(from, to.circleId).expect(201)).body as { id: string };
      await request_(from, to.circleId).expect(409);
      await from.supervisor.post(`/v1/supervisor/transfers/${id}/cancel`).expect(204);
      await request_(from, to.circleId).expect(201);
    });

    it('stops at acceptance when the circle has filled up', async () => {
      const { from, to } = await pair();
      await to.supervisor.patch(`/v1/supervisor/circles/${to.circleId}`).send({ capacity: 1 }).expect(204);
      const { id } = (await request_(from, to.circleId).expect(201)).body as { id: string };
      await admin.post(`/v1/admin/transfers/${id}/approve`).expect(204);
      expect((await to.teacher.client.post(`/v1/teacher/transfers/${id}/accept`).expect(409)).body).toMatchObject({ code: 'circle_full' });
      await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(200);
    });

    it('can be refused by the administration or the new teacher, leaving the student in place', async () => {
      const { from, to } = await pair();
      const first = (await request_(from, to.circleId).expect(201)).body as { id: string };
      await admin.post(`/v1/admin/transfers/${first.id}/reject`).expect(204);
      const second = (await request_(from, to.circleId).expect(201)).body as { id: string };
      await admin.post(`/v1/admin/transfers/${second.id}/approve`).expect(204);
      await to.teacher.client.post(`/v1/teacher/transfers/${second.id}/reject`).expect(204);
      await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(200);
    });
  });

  describe('administration', () => {
    // The whole file can outlast an access token, and the administrator signs in only once.
    beforeEach(async () => {
      await admin.post('/v1/staff/auth/refresh').expect((response) => expect(response.ok).toBe(true));
    });

    it('refuses a duplicate email', async () => {
      const email = uniqueEmail();
      await admin.post('/v1/admin/staff').send({ fullName: 'a', email, role: 'TEACHER', scopeId: scopeA }).expect(201);
      await admin.post('/v1/admin/staff').send({ fullName: 'b', email, role: 'TEACHER', scopeId: scopeA }).expect(409);
    });

    it('needs a scope for teachers and supervisors, and none for administrators', async () => {
      await admin.post('/v1/admin/staff').send({ fullName: 'a', email: uniqueEmail(), role: 'TEACHER' }).expect(400);
      await admin.post('/v1/admin/staff').send({ fullName: 'a', email: uniqueEmail(), role: 'ADMIN', scopeId: scopeA }).expect(400);
      await admin.post('/v1/admin/staff').send({ fullName: 'a', email: uniqueEmail(), role: 'TEACHER', scopeId: randomId() }).expect(400);
    });

    it('will not suspend or move a teacher who has a circle', async () => {
      const w = await world(scopeA);
      await admin.patch(`/v1/admin/staff/${w.teacher.id}`).send({ status: 'SUSPENDED' }).expect(409);
      await admin.patch(`/v1/admin/staff/${w.teacher.id}`).send({ scopeId: scopeB }).expect(409);
    });

    describe('managing supervisors and teachers', () => {
      type Detail = {
        account: { id: string };
        stats: { students: number; circles: number } | null;
        teachers: { id: string; circles: { id: string; students: number }[] }[];
        circles: { id: string }[];
        students: { id: string }[];
        supervisors: { id: string }[];
        transfers: { id: string; status: string }[];
      };

      it('shows a supervisor what they answer for, and a teacher their students', async () => {
        const scope = ((await admin.post('/v1/admin/scopes').send({ name: `ج ${randomId()}` }).expect(201)).body as { id: string }).id;
        const supervisor = await createStaff('SUPERVISOR', scope);
        const w = await world(scope, supervisor.client);

        const ofSupervisor = (await admin.get(`/v1/admin/supervisors/${supervisor.id}`).expect(200)).body as Detail;
        expect(ofSupervisor.stats?.students).toBe(1);
        expect(ofSupervisor.circles.map(({ id }) => id)).toEqual([w.circleId]);
        expect(ofSupervisor.teachers).toEqual([expect.objectContaining({ id: w.teacher.id, circles: [expect.objectContaining({ id: w.circleId, students: 1 })] })]);

        const ofTeacher = (await admin.get(`/v1/admin/teachers/${w.teacher.id}`).expect(200)).body as Detail;
        expect(ofTeacher.students.map(({ id }) => id)).toEqual([w.studentId]);
        expect(ofTeacher.supervisors.map(({ id }) => id)).toEqual([supervisor.id]);

        const { body: listed } = await admin.get(`/v1/admin/staff?role=SUPERVISOR&scopeId=${scope}`).expect(200);
        expect((listed as { items: object[] }).items).toEqual([expect.objectContaining({ id: supervisor.id, teachers: 1, students: 1 })]);
        expect(JSON.stringify(ofSupervisor)).not.toContain('passwordHash');
      });

      it('answers 404 for an id of another role, and only to administrators', async () => {
        const w = await world(scopeA);
        await admin.get(`/v1/admin/supervisors/${w.teacher.id}`).expect(404);
        await admin.get(`/v1/admin/teachers/${randomId()}`).expect(404);
        await w.supervisor.get(`/v1/admin/teachers/${w.teacher.id}`).expect(403);
        await w.teacher.client.get(`/v1/admin/teachers/${w.teacher.id}`).expect(403);
        await w.supervisor.patch(`/v1/admin/circles/${w.circleId}`).send({ name: 'x' }).expect(403);
      });

      it('moves a teacher to another scope with their circle and students', async () => {
        const w = await world(scopeA);
        await admin.post(`/v1/admin/teachers/${w.teacher.id}/move`).send({ scopeId: scopeB }).expect(204);
        const { account, circles, students } = (await admin.get(`/v1/admin/teachers/${w.teacher.id}`).expect(200)).body as Detail & { account: { scope: { id: string } } };
        expect(account.scope.id).toBe(scopeB);
        expect(circles.map(({ id }) => id)).toEqual([w.circleId]);
        expect(students).toHaveLength(1);
        // The old supervisor loses them at once.
        await w.supervisor.post(`/v1/supervisor/circles/${w.circleId}/students`).send({ studentId: await newStudentId() }).expect(404);
        await admin.post(`/v1/admin/teachers/${w.teacher.id}/move`).send({ scopeId: randomId() }).expect(400);
      });

      it('changes a circle’s teacher, frees a teacher to be suspended, and cancels the old teacher’s sessions', async () => {
        const w = await world(scopeA);
        const replacement = await createStaff('TEACHER', scopeA);
        const elsewhere = await createStaff('TEACHER', scopeB);
        const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
        const { body: session } = await w.teacher.client.post('/v1/teacher/sessions').send({ kind: 'RECITATION', title: 'مقطع', scheduledAt, studentId: w.studentId }).expect(201);

        await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ teacherId: elsewhere.id }).expect(404);
        await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ scopeId: scopeB }).expect(409);
        await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ capacity: 0 }).expect(400);
        await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ teacherId: replacement.id }).expect(204);

        const { body: cancelled } = await w.teacher.client.get(`/v1/teacher/sessions/${(session as { id: string }).id}`).expect(200);
        expect((cancelled as { status: string }).status).toBe('CANCELLED');
        await admin.patch(`/v1/admin/staff/${w.teacher.id}`).send({ status: 'SUSPENDED' }).expect(200);

        await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ teacherId: null }).expect(204);
        await admin.patch(`/v1/admin/circles/${w.circleId}`).send({ scopeId: scopeB, name: 'حلقة منقولة' }).expect(204);
        const circles = (await admin.get('/v1/admin/circles').expect(200)).body as { id: string; name: string; teacher: object | null; scope: { id: string } }[];
        expect(circles.find(({ id }) => id === w.circleId)).toMatchObject({ name: 'حلقة منقولة', teacher: null, scope: { id: scopeB } });
      });

      it('edits a staff member’s contact details, refusing one already in use', async () => {
        const first = await createStaff('TEACHER', scopeA);
        const second = await createStaff('TEACHER', scopeA);
        const email = uniqueEmail();
        await admin.patch(`/v1/admin/staff/${first.id}`).send({ fullName: 'اسم جديد', email }).expect(200);
        await admin.patch(`/v1/admin/staff/${second.id}`).send({ email }).expect(409);
        await agent().post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
      });

      it('assigns and removes a student, who keeps their plan', async () => {
        const w = await world(scopeA);
        const student = await newStudentId();
        await admin.post(`/v1/admin/circles/${w.circleId}/students`).send({ studentId: student }).expect(204);
        await admin.post(`/v1/admin/circles/${w.circleId}/students`).send({ studentId: student }).expect(409);

        await admin.delete(`/v1/admin/circles/${w.circleId}/students/${student}`).expect(204);
        await admin.delete(`/v1/admin/circles/${w.circleId}/students/${student}`).expect(404);
        await w.teacher.client.get(`/v1/teacher/students/${student}`).expect(404);
        await admin.post(`/v1/admin/circles/${w.circleId}/students`).send({ studentId: student }).expect(204);
        await w.teacher.client.get(`/v1/teacher/students/${student}`).expect(200);
      });

      it('sends its own transfer straight to the new teacher, who still accepts it', async () => {
        const from = await world(scopeA);
        const to = await world(scopeB);
        const { body } = await admin.post('/v1/admin/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);
        const transfer = body as { id: string; status: string };
        expect(transfer.status).toBe('PENDING_TEACHER');
        await admin.post('/v1/admin/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(409);

        // Removing them from a circle they aren't in fails, and leaves the transfer open.
        await admin.delete(`/v1/admin/circles/${to.circleId}/students/${from.studentId}`).expect(404);
        await admin.post('/v1/admin/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(409);

        // Nothing changes until the teacher accepts.
        await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(200);
        await admin.post(`/v1/admin/transfers/${transfer.id}/cancel`).expect(204);
        await admin.post(`/v1/admin/transfers/${transfer.id}/cancel`).expect(404);

        const { body: again } = await admin.post('/v1/admin/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);
        await to.teacher.client.post(`/v1/teacher/transfers/${(again as { id: string }).id}/accept`).expect(204);
        await from.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(404);
        await to.teacher.client.get(`/v1/teacher/students/${from.studentId}`).expect(200);
      });

      it('will not transfer into a circle with nobody to accept', async () => {
        const w = await world(scopeA);
        const { body } = await admin.post('/v1/admin/circles').send({ name: 'بلا معلمة', scopeId: scopeA, trackId: await trackIdOf(t) }).expect(201);
        await admin.post('/v1/admin/transfers').send({ studentId: w.studentId, toCircleId: (body as { id: string }).id }).expect(409);
      });

      it('archives only an empty circle, ending what was waiting on it', async () => {
        const from = await world(scopeA);
        const to = await world(scopeA);
        await admin.delete(`/v1/admin/circles/${to.circleId}`).expect(409);
        const { body } = await admin.post('/v1/admin/transfers').send({ studentId: from.studentId, toCircleId: to.circleId }).expect(201);

        await admin.delete(`/v1/admin/circles/${to.circleId}/students/${to.studentId}`).expect(204);
        await admin.delete(`/v1/admin/circles/${to.circleId}`).expect(204);
        await admin.patch(`/v1/admin/circles/${to.circleId}`).send({ name: 'x' }).expect(404);
        await to.teacher.client.post(`/v1/teacher/transfers/${(body as { id: string }).id}/accept`).expect(404);
      });
    });

    it('suspends a student at once', async () => {
      const { accessToken } = await register(t);
      const { id } = (await t.http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200)).body as { id: string };
      await admin.patch(`/v1/admin/students/${id}`).send({ status: 'SUSPENDED' }).expect(204);
      await t.http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    });

    it('controls one student fully: file, details, circle, plan, sessions and deletion', async () => {
      const from = await world(scopeA);
      const to = await world(scopeA);
      const id = from.studentId;

      const detail = async () => (await admin.get(`/v1/admin/students/${id}`).expect(200)).body as { name: string; circle: { id: string } | null; phone: string };
      expect((await detail()).circle?.id).toBe(from.circleId);
      await admin.get(`/v1/admin/students/${id}/record`).expect(200);

      await admin.patch(`/v1/admin/students/${id}`).send({ fullName: 'اسم جديد', ageBand: '20' }).expect(204);
      expect((await detail()).name).toBe('اسم جديد');
      await admin.patch(`/v1/admin/students/${id}`).send({}).expect(400);

      // Straight into the other circle, without the teacher's acceptance.
      await admin.post(`/v1/admin/students/${id}/move`).send({ circleId: to.circleId }).expect(204);
      expect((await detail()).circle?.id).toBe(to.circleId);
      await admin.post(`/v1/admin/students/${id}/move`).send({ circleId: to.circleId }).expect(409);

      await admin.post(`/v1/admin/students/${id}/reset-plan`).expect(204);
      await admin.post(`/v1/admin/students/${id}/sign-out`).expect(204);

      await admin.delete(`/v1/admin/students/${id}`).expect(204);
      await admin.get(`/v1/admin/students/${id}`).expect(404);
    });

    it('signs a student out of every device', async () => {
      const { accessToken, refreshToken } = await register(t);
      const { id } = (await t.http().get('/v1/me').set('Authorization', `Bearer ${accessToken}`).expect(200)).body as { id: string };
      await admin.post(`/v1/admin/students/${id}/sign-out`).expect(204);
      await t.http().post('/v1/auth/refresh').send({ refreshToken }).expect(401);
      // Staff are not students, and these routes never reach them.
      const teacher = await createStaff('TEACHER', scopeA);
      await admin.post(`/v1/admin/students/${teacher.id}/sign-out`).expect(404);
      await admin.delete(`/v1/admin/students/${teacher.id}`).expect(404);
    });

    it('lists with capped pages', async () => {
      await admin.get('/v1/admin/students?limit=101').expect(400);
      await admin.get('/v1/admin/students?limit=-1').expect(400);
      await admin.get('/v1/admin/students?limit=5&limit=6').expect(400);
      const { body } = await admin.get('/v1/admin/students?limit=1').expect(200);
      expect((body as { items: object[] }).items).toHaveLength(1);
    });

    it('reaches every audience with announcements, each only within its limits', async () => {
      await admin.post('/v1/admin/broadcasts').send({ kind: 'ANNOUNCEMENT', title: 'للجميع', body: 'نص', audience: { type: 'ALL' } }).expect(201);
      const w = await world(scopeA);
      await w.supervisor.post('/v1/supervisor/announcements').send({ audience: 'SCOPE', title: 'للنطاق', body: 'نص' }).expect(201);
      await w.supervisor.post('/v1/supervisor/announcements').send({ audience: 'SCOPE', circleId: w.circleId, title: 'x', body: 'x' }).expect(400);
      await w.supervisor.post('/v1/supervisor/announcements').send({ audience: 'CIRCLE', title: 'x', body: 'x' }).expect(400);
    });
  });

  describe('an admin using another account', () => {
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
    const impersonate = (client: Agent, id: string) => client.post(`/v1/staff/auth/impersonate/${id}`);
    /** As the private window does: it has none of the admin's cookies, only the link. */
    const redeem = (ticket: string) => request(t.app.getHttpServer()).post('/v1/staff/auth/impersonate').set('Origin', ORIGIN).send({ ticket });
    const ticketFor = async (client: Agent, id: string) => ((await impersonate(client, id).expect(200)).body as { ticket: string }).ticket;
    const openAs = async (client: Agent, id: string) => ((await redeem(await ticketFor(client, id)).expect(200)).body as { token: string }).token;

    it('opens a supervisor with an authenticator, without its password or code, in a session of its own', async () => {
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      const response = await impersonate(admin, supervisor.id).expect(200);
      // No cookie: the admin's own session in this browser is left as it was.
      expect(response.headers['set-cookie']).toBeUndefined();
      const { ticket } = response.body as { ticket: string };
      // The link itself opens nothing: it only buys a session, once.
      await agent().get('/v1/staff/auth/me').set(bearer(ticket)).expect(401);
      const redeemed = await redeem(ticket).expect(200);
      expect(redeemed.headers['set-cookie']).toBeUndefined();
      const { token } = redeemed.body as { token: string };
      expect((await redeem(ticket).expect(401)).body).toMatchObject({ code: 'invalid_ticket' });

      const { body: me } = await agent().get('/v1/staff/auth/me').set(bearer(token)).expect(200);
      expect(me).toMatchObject({ id: supervisor.id, role: 'SUPERVISOR', impersonatedBy: { id: adminId } });
      await agent().get('/v1/supervisor/circles').set(bearer(token)).expect(200);
      // It is the supervisor, not an admin.
      await agent().get('/v1/admin/scopes').set(bearer(token)).expect(403);
      expect((await admin.get('/v1/staff/auth/me').expect(200)).body as { role: string; impersonatedBy: unknown }).toMatchObject({
        role: 'ADMIN',
        impersonatedBy: null,
      });

      // The browser asks first whether the dashboard may send the session header at all.
      const preflight = await request(t.app.getHttpServer())
        .options('/v1/staff/auth/me')
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization')
        .expect(204);
      expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');

      const audit = await t.prisma.auditLog.findFirst({ where: { action: 'staff.impersonate', targetId: supervisor.id } });
      expect(audit).toMatchObject({ actorId: adminId, actorRole: 'ADMIN' });
    });

    it('opens a teacher, and leaves the password to its owner', async () => {
      const w = await world(scopeA);
      const token = await openAs(admin, w.teacher.id);
      const { body: me } = await agent().get('/v1/staff/auth/me').set(bearer(token)).expect(200);
      expect(me).toMatchObject({ role: 'TEACHER', impersonatedBy: { id: adminId } });
      await agent()
        .post('/v1/staff/auth/password/change')
        .set(bearer(token))
        .send({ currentPassword: PASSWORD, newPassword: 'Another-Sturdy-Pass-5512' })
        .expect(403);
      // A session can't be passed off as a link.
      await redeem(token).expect(401);
    });

    it('is for admins only, and only on an active teacher or supervisor', async () => {
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      const teacher = await createStaff('TEACHER', scopeA);
      await impersonate(supervisor.client, teacher.id).expect(403);
      await impersonate(admin, adminId).expect(404);
      await impersonate(admin, await newStudentId()).expect(404);
      // Suspended after the link was made: the link no longer works.
      const ticket = await ticketFor(admin, teacher.id);
      await admin.patch(`/v1/admin/staff/${teacher.id}`).send({ status: 'SUSPENDED' }).expect(200);
      await redeem(ticket).expect(401);
      expect((await impersonate(admin, teacher.id).expect(409)).body).toMatchObject({ code: 'account_suspended' });
      await agent().get('/v1/staff/auth/me').set(bearer('not-a-token')).expect(401);
    });

    it('ends when the account is suspended or the admin signs out', async () => {
      const email = uniqueEmail();
      await t.prisma.user.create({
        data: {
          email,
          fullName: 'مديرة ثانية',
          role: 'ADMIN',
          staffCredential: { create: { passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } },
        },
      });
      const { client: secondAdmin } = await loginWithEnrollment(email);
      const supervisor = await createStaff('SUPERVISOR', scopeA);
      const teacher = await createStaff('TEACHER', scopeA);

      const asTeacher = await openAs(secondAdmin, teacher.id);
      const asSupervisor = await openAs(secondAdmin, supervisor.id);
      const unusedLink = await ticketFor(secondAdmin, teacher.id);
      await agent().get('/v1/staff/auth/me').set(bearer(asTeacher)).expect(200);

      await admin.patch(`/v1/admin/staff/${supervisor.id}`).send({ status: 'SUSPENDED' }).expect(200);
      await agent().get('/v1/staff/auth/me').set(bearer(asSupervisor)).expect(401);

      await secondAdmin.post('/v1/staff/auth/logout').expect(204);
      await agent().get('/v1/staff/auth/me').set(bearer(asTeacher)).expect(401);
      await redeem(unusedLink).expect(401);
      // Signed out, the admin can't make another link.
      await impersonate(secondAdmin, teacher.id).expect(401);
    });
  });
});
