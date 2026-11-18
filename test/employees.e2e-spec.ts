import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { randomId } from '../src/common/ids.js';
import { createTestApp, keepStaffSignedIn, type TestApp } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';

type Agent = ReturnType<typeof request.agent>;
type Rank = { id: string; name: string; permissions: string[]; employees: number };
const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;

describe('employees and ranks', () => {
  let t: TestApp;
  const agent = (): Agent => request.agent(t.app.getHttpServer()).set('Origin', ORIGIN);

  let admin: Agent;
  let adminId: string;
  let scopeId: string;

  async function loginWithEnrollment(email: string): Promise<Agent> {
    const client = agent();
    const { body } = await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    const { mfaToken, next } = body as { mfaToken: string; next: string };
    expect(next).toBe('enroll_totp');
    const { body: enrollment } = await client.post('/v1/staff/auth/totp/enroll').send({ mfaToken }).expect(200);
    const { secret } = enrollment as { secret: string };
    await client.post('/v1/staff/auth/totp/confirm').send({ mfaToken, code: generateSync({ secret }) }).expect(200);
    return client;
  }

  async function createRank(permissions: string[], name = `رتبة ${randomId().slice(0, 8)}`) {
    const { body } = await admin.post('/v1/admin/ranks').send({ name, permissions }).expect(201);
    return body as Rank;
  }

  async function createEmployee(rankId: string) {
    const email = uniqueEmail();
    const { body } = await admin.post('/v1/admin/staff').send({ fullName: 'موظفة الإدارة', email, role: 'EMPLOYEE', rankId }).expect(201);
    const created = body as { staff: { id: string; rank: { id: string } | null }; setupToken: string };
    expect(created.staff.rank?.id).toBe(rankId);
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
    return { id: created.staff.id, client: await loginWithEnrollment(email) };
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
    admin = await loginWithEnrollment(email);
    scopeId = ((await admin.post('/v1/admin/scopes').send({ name: `نطاق ${randomId()}` }).expect(201)).body as { id: string }).id;
  });
  afterAll(async () => {
    await t.app.close();
  });
  keepStaffSignedIn(() => [admin]);

  describe('ranks', () => {
    it('lists the permission catalog for building a rank', async () => {
      const { body } = await admin.get('/v1/admin/permissions').expect(200);
      const keys = (body as { key: string; label: string }[]).map(({ key }) => key);
      expect(keys).toContain('students.manage');
      expect(keys).toContain('audit.view');
    });

    it('rejects an unknown permission and a duplicate name', async () => {
      await admin.post('/v1/admin/ranks').send({ name: `خطأ ${randomId()}`, permissions: ['ranks.manage'] }).expect(400);
      const rank = await createRank(['students.manage']);
      await admin.post('/v1/admin/ranks').send({ name: rank.name, permissions: [] }).expect(409);
    });

    it('will not delete a rank while an employee holds it', async () => {
      const rank = await createRank(['students.manage']);
      const employee = await createEmployee(rank.id);
      await admin.delete(`/v1/admin/ranks/${rank.id}`).expect(409);

      const other = await createRank(['audit.view']);
      await admin.patch(`/v1/admin/staff/${employee.id}`).send({ rankId: other.id }).expect(200);
      await admin.delete(`/v1/admin/ranks/${rank.id}`).expect(204);
    });

    it('needs a rank for an employee, and gives none to anyone else', async () => {
      await admin.post('/v1/admin/staff').send({ fullName: 'بلا رتبة', email: uniqueEmail(), role: 'EMPLOYEE' }).expect(400);
      const rank = await createRank(['students.manage']);
      await admin
        .post('/v1/admin/staff')
        .send({ fullName: 'معلمة', email: uniqueEmail(), role: 'TEACHER', scopeId, rankId: rank.id })
        .expect(400);
      await admin.post('/v1/admin/staff').send({ fullName: 'موظفة', email: uniqueEmail(), role: 'EMPLOYEE', rankId: rank.id, scopeId }).expect(400);
    });
  });

  describe('what an employee may do', () => {
    it('reaches only the sections their rank opens', async () => {
      const rank = await createRank(['students.manage']);
      const { client } = await createEmployee(rank.id);

      await client.get('/v1/admin/students').expect(200);
      await client.get('/v1/admin/tracks').expect(200);
      await client.get('/v1/admin/audit').expect(403);
      await client.get('/v1/admin/certificates').expect(403);
      await client.put('/v1/admin/settings/features').send({}).expect(403);
      await client.get('/v1/stage-exams').expect(403);
    });

    it('sees their own rank and permissions in their profile', async () => {
      const rank = await createRank(['audit.view', 'reports.view']);
      const { client } = await createEmployee(rank.id);
      const { body } = await client.get('/v1/staff/auth/me').expect(200);
      expect(body).toMatchObject({ role: 'EMPLOYEE', scope: null, rank: { id: rank.id, name: rank.name } });
      expect((body as { rank: Rank }).rank.permissions.sort()).toEqual(['audit.view', 'reports.view']);
    });

    it('feels a change to the rank on the very next request', async () => {
      const rank = await createRank(['audit.view']);
      const { client } = await createEmployee(rank.id);
      await client.get('/v1/admin/audit').expect(200);

      await admin.patch(`/v1/admin/ranks/${rank.id}`).send({ permissions: [] }).expect(200);
      await client.get('/v1/admin/audit').expect(403);
      // A rank that grants nothing opens not even the shared lookups.
      await client.get('/v1/admin/tracks').expect(403);
    });

    it('never manages ranks, administrators, other employees, or impersonation', async () => {
      const rank = await createRank(['accounts.manage']);
      const { id, client } = await createEmployee(rank.id);
      const peer = await createEmployee(rank.id);

      await client.get('/v1/admin/ranks').expect(403);
      await client.post('/v1/admin/ranks').send({ name: `تصعيد ${randomId()}`, permissions: ['audit.view'] }).expect(403);
      await client.post('/v1/admin/staff').send({ fullName: 'مديرة', email: uniqueEmail(), role: 'ADMIN' }).expect(403);
      await client.post('/v1/admin/staff').send({ fullName: 'موظفة', email: uniqueEmail(), role: 'EMPLOYEE', rankId: rank.id }).expect(403);
      await client.patch(`/v1/admin/staff/${adminId}`).send({ fullName: 'اسم جديد' }).expect(403);
      await client.patch(`/v1/admin/staff/${peer.id}`).send({ status: 'SUSPENDED' }).expect(403);
      await client.post(`/v1/admin/staff/${adminId}/reset-credentials`).expect(403);
      await client.delete(`/v1/admin/staff/${peer.id}`).expect(403);
      await client.patch(`/v1/admin/staff/${id}`).send({ rankId: rank.id }).expect(409);

      // What the rank does open: teachers' and supervisors' accounts.
      const { body } = await client
        .post('/v1/admin/staff')
        .send({ fullName: 'معلمة جديدة', email: uniqueEmail(), role: 'TEACHER', scopeId })
        .expect(201);
      const teacherId = (body as { staff: { id: string } }).staff.id;
      await client.post(`/v1/staff/auth/impersonate/${teacherId}`).expect(403);
    });

    it('is recorded in the audit log as an employee', async () => {
      const rank = await createRank(['students.manage']);
      const { id, client } = await createEmployee(rank.id);
      await client.post('/v1/admin/scopes').send({ name: `لا ${randomId()}` }).expect(403);
      await client.get('/v1/admin/students').expect(200);

      const before = await t.prisma.auditLog.count({ where: { actorId: id } });
      await admin.patch(`/v1/admin/ranks/${rank.id}`).send({ permissions: ['students.manage', 'accounts.manage'] }).expect(200);
      await client.post('/v1/admin/scopes').send({ name: `نعم ${randomId()}` }).expect(201);
      const row = await t.prisma.auditLog.findFirstOrThrow({ where: { actorId: id }, orderBy: { createdAt: 'desc' } });
      expect(row).toMatchObject({ actorRole: 'EMPLOYEE', action: 'scope.create' });
      expect(await t.prisma.auditLog.count({ where: { actorId: id } })).toBe(before + 1);
    });

    it('stops at once when the account is suspended', async () => {
      const rank = await createRank(['students.manage']);
      const { id, client } = await createEmployee(rank.id);
      await client.get('/v1/admin/students').expect(200);
      await admin.patch(`/v1/admin/staff/${id}`).send({ status: 'SUSPENDED' }).expect(200);
      await client.get('/v1/admin/students').expect(401);
    });
  });
});
