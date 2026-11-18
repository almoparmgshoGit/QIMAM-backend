import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { WebSocket } from 'ws';
import { randomId } from '../src/common/ids.js';
import { createTestApp, keepStaffSignedIn, register, type TestApp } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';

type Agent = ReturnType<typeof request.agent>;
type Ticket = { id: string; status: string; unread: number; subject: string; assignee?: { id: string } | null };
type Message = { id: string; body: string; fromSupport: boolean };
const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;

describe('support conversations', () => {
  let t: TestApp;
  const agent = (): Agent => request.agent(t.app.getHttpServer()).set('Origin', ORIGIN);

  let admin: Agent;
  let adminId: string;
  let student: { accessToken: string };
  const asStudent = () => ({ Authorization: `Bearer ${student.accessToken}` });

  async function loginWithEnrollment(email: string): Promise<Agent> {
    const client = agent();
    const { body } = await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    const { mfaToken } = body as { mfaToken: string };
    const { body: enrollment } = await client.post('/v1/staff/auth/totp/enroll').send({ mfaToken }).expect(200);
    await client.post('/v1/staff/auth/totp/confirm').send({ mfaToken, code: generateSync({ secret: (enrollment as { secret: string }).secret }) }).expect(200);
    return client;
  }

  async function createEmployee(permissions: string[]) {
    const { body: rank } = await admin.post('/v1/admin/ranks').send({ name: `رتبة ${randomId().slice(0, 8)}`, permissions }).expect(201);
    const email = uniqueEmail();
    const { body } = await admin
      .post('/v1/admin/staff')
      .send({ fullName: 'موظفة الدعم', email, role: 'EMPLOYEE', rankId: (rank as { id: string }).id })
      .expect(201);
    const created = body as { staff: { id: string }; setupToken: string };
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
    return { id: created.staff.id, client: await loginWithEnrollment(email) };
  }

  async function createTeacher() {
    const scope = await admin.post('/v1/admin/scopes').send({ name: `نطاق ${randomId()}` }).expect(201);
    const email = uniqueEmail();
    const { body } = await admin
      .post('/v1/admin/staff')
      .send({ fullName: 'معلمة', email, role: 'TEACHER', scopeId: (scope.body as { id: string }).id })
      .expect(201);
    const created = body as { staff: { id: string }; setupToken: string };
    await agent().post('/v1/staff/auth/password/set').send({ token: created.setupToken, password: PASSWORD }).expect(204);
    const client = agent();
    await client.post('/v1/staff/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
    return client;
  }

  const openTicket = async (subject = 'لا يعمل التسجيل الصوتي') =>
    (
      await t
        .http()
        .post('/v1/me/support/tickets')
        .set(asStudent())
        .send({ subject, category: 'TECHNICAL', body: 'يتوقف التسجيل بعد دقيقة.' })
        .expect(201)
    ).body as { ticket: Ticket; messages: Message[] };

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
    student = await register(t);
  });
  afterAll(async () => {
    await t.app.close();
  });
  keepStaffSignedIn(() => [admin]);

  it('carries a conversation between a student and support, with unread counts on each side', async () => {
    const { ticket, messages } = await openTicket();
    expect(ticket.status).toBe('OPEN');
    expect(messages).toHaveLength(1);

    const { body: inbox } = await admin.get('/v1/admin/support/tickets').query({ unread: 'true' }).expect(200);
    const listed = (inbox as { items: (Ticket & { requester: { role: string } })[] }).items.find(({ id }) => id === ticket.id);
    expect(listed?.unread).toBe(1);
    expect(listed?.requester.role).toBe('STUDENT');

    const { body: reply } = await admin.post(`/v1/admin/support/tickets/${ticket.id}/messages`).send({ body: 'جرّبي تحديث التطبيق.' }).expect(201);
    expect((reply as Message).fromSupport).toBe(true);

    const { body: mine } = await t.http().get(`/v1/me/support/tickets/${ticket.id}`).set(asStudent()).expect(200);
    const view = mine as { ticket: Ticket; messages: (Message & { author?: unknown })[] };
    expect(view.ticket.unread).toBe(1);
    expect(view.messages.map(({ fromSupport }) => fromSupport)).toEqual([false, true]);
    // The student never learns which staff member answered.
    expect(view.messages[1].author).toBeUndefined();

    // Answering took the conversation on.
    const { body: detail } = await admin.get(`/v1/admin/support/tickets/${ticket.id}`).expect(200);
    expect((detail as { ticket: Ticket }).ticket.assignee?.id).toBe(adminId);
    expect((detail as { ticket: Ticket }).ticket.unread).toBe(0);

    await t.http().post(`/v1/me/support/tickets/${ticket.id}/read`).set(asStudent()).expect(204);
    const { body: unread } = await t.http().get('/v1/me/support/unread').set(asStudent()).expect(200);
    expect((unread as { unread: number }).unread).toBe(0);

    const notice = await t.prisma.notification.findFirst({ where: { dedupeKey: `support-reply:${ticket.id}:${(reply as Message).id}` } });
    expect(notice).not.toBeNull();
    // The student's notification opens this very conversation.
    const { body: notices } = await t.http().get('/v1/me/notifications').set(asStudent()).expect(200);
    const shown = (notices as { id: string; opens: string | null; ticketId: string | null }[]).find(({ id }) => id === notice!.id);
    expect(shown).toMatchObject({ opens: 'support', ticketId: ticket.id });
  });

  it('keeps each requester to her own conversations', async () => {
    const { ticket } = await openTicket();
    const other = await register(t);
    await t.http().get(`/v1/me/support/tickets/${ticket.id}`).set({ Authorization: `Bearer ${other.accessToken}` }).expect(404);
    await t
      .http()
      .post(`/v1/me/support/tickets/${ticket.id}/messages`)
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .send({ body: 'مرحبا' })
      .expect(404);
  });

  it('closes, and a new message from the requester opens it again', async () => {
    const { ticket } = await openTicket();
    const { body: closed } = await t.http().post(`/v1/me/support/tickets/${ticket.id}/close`).set(asStudent()).expect(201);
    expect((closed as Ticket).status).toBe('CLOSED');
    await t.http().post(`/v1/me/support/tickets/${ticket.id}/messages`).set(asStudent()).send({ body: 'ما زالت المشكلة.' }).expect(201);
    const { body } = await t.http().get(`/v1/me/support/tickets/${ticket.id}`).set(asStudent()).expect(200);
    expect((body as { ticket: Ticket }).ticket.status).toBe('OPEN');
  });

  it('opens the inbox to employees whose rank grants support, and only to them', async () => {
    const without = await createEmployee(['students.manage']);
    await without.client.get('/v1/admin/support/tickets').expect(403);

    const helper = await createEmployee(['support.manage']);
    const { ticket } = await openTicket();
    await helper.client.get(`/v1/admin/support/tickets/${ticket.id}`).expect(200);

    // Only support staff can be assigned.
    await admin.patch(`/v1/admin/support/tickets/${ticket.id}`).send({ assigneeId: without.id }).expect(422);
    const { body } = await admin.patch(`/v1/admin/support/tickets/${ticket.id}`).send({ assigneeId: helper.id, status: 'CLOSED' }).expect(200);
    expect((body as Ticket).assignee?.id).toBe(helper.id);
    expect((body as Ticket).status).toBe('CLOSED');

    const { body: assignees } = await admin.get('/v1/admin/support/assignees').expect(200);
    const ids = (assignees as { id: string }[]).map(({ id }) => id);
    expect(ids).toContain(helper.id);
    expect(ids).not.toContain(without.id);
  });

  it('lets a teacher ask for help from the dashboard, but not answer', async () => {
    const teacher = await createTeacher();
    const { body } = await teacher.post('/v1/staff/support/tickets').send({ subject: 'لا تظهر حلقتي', body: 'اختفت الحلقة من القائمة.' }).expect(201);
    const { ticket } = body as { ticket: Ticket };
    await teacher.get('/v1/admin/support/tickets').expect(403);
    const { body: detail } = await admin.get(`/v1/admin/support/tickets/${ticket.id}`).expect(200);
    expect((detail as { ticket: { requester: { role: string } } }).ticket.requester.role).toBe('TEACHER');
  });

  it('limits how many conversations one requester keeps open', async () => {
    const someone = await register(t);
    const open = () =>
      t.http().post('/v1/me/support/tickets').set({ Authorization: `Bearer ${someone.accessToken}` }).send({ subject: 'سؤال', body: 'نص' });
    for (let i = 0; i < 5; i++) await open().expect(201);
    const { body } = await open().expect(409);
    expect((body as { code: string }).code).toBe('too_many_open_tickets');
  });

  it('announces a new message live to both sides', async () => {
    const server = t.app.getHttpServer();
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const connect = async (ticket: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/support`);
      const events: { type: string; ticketId?: string; message?: Message }[] = [];
      socket.on('message', (raw) => events.push(JSON.parse(String(raw)) as (typeof events)[number]));
      await new Promise((resolve) => socket.once('open', resolve));
      socket.send(JSON.stringify({ type: 'join', ticket }));
      await vi.waitFor(() => expect(events.some(({ type }) => type === 'ready')).toBe(true));
      return { socket, events };
    };

    const { body: studentTicket } = await t.http().post('/v1/me/support/socket-ticket').set(asStudent()).expect(201);
    const { body: staffTicket } = await admin.post('/v1/admin/support/socket-ticket').expect(201);
    const studentSide = await connect((studentTicket as { ticket: string }).ticket);
    const supportSide = await connect((staffTicket as { ticket: string }).ticket);

    // A ticket works once.
    const reused = new WebSocket(`ws://127.0.0.1:${port}/v1/support`);
    const closed = new Promise<number>((resolve) => reused.once('close', resolve));
    reused.once('open', () => reused.send(JSON.stringify({ type: 'join', ticket: (studentTicket as { ticket: string }).ticket })));
    expect(await closed).toBe(4000);

    const { ticket } = await openTicket();
    await admin.post(`/v1/admin/support/tickets/${ticket.id}/messages`).send({ body: 'وصلت رسالتك.' }).expect(201);

    await vi.waitFor(() => {
      expect(studentSide.events.some((event) => event.type === 'message' && event.message?.body === 'وصلت رسالتك.')).toBe(true);
      expect(supportSide.events.some((event) => event.type === 'ticket' && event.ticketId === undefined)).toBe(true);
      expect(supportSide.events.some((event) => event.type === 'message' && event.ticketId === ticket.id)).toBe(true);
    });
    studentSide.socket.close();
    supportSide.socket.close();
  });
});
