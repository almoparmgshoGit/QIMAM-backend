import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import request from 'supertest';
import { WebSocket } from 'ws';
import { randomId } from '../src/common/ids.js';
import { createTestApp, register, type TestApp, trackIdOf } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Sturdy-Pass-9271-xyz';
type Agent = ReturnType<typeof request.agent>;
type Message = { type: string; [key: string]: unknown };

const uniqueEmail = () => `${randomId().replace(/[^A-Za-z0-9]/g, 'x').toLowerCase()}@qimam.test`;

/** A socket whose messages can be awaited one at a time, in order. */
class Client {
  private readonly queue: Message[] = [];
  private waiting: ((message: Message) => void) | null = null;
  readonly closed: Promise<number>;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Message;
      if (this.waiting) {
        this.waiting(message);
        this.waiting = null;
      } else {
        this.queue.push(message);
      }
    });
    this.closed = new Promise((resolve) => socket.on('close', resolve));
  }

  next(): Promise<Message> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message arrived')), 5000);
      this.waiting = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    });
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }
}

describe('sessions, attendance, certificates', () => {
  let t: TestApp;
  let admin: Agent;
  let scope: string;
  let supervisor: Agent;
  let port: number;
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
    const { id: circleId } = (await supervisor.post('/v1/supervisor/circles').send({ name: `حلقة ${randomId().slice(0, 6)}`, teacherId: teacher.id, trackId: await trackIdOf(t) }).expect(201)).body as { id: string };
    const student = await newStudent();
    await supervisor.post(`/v1/supervisor/circles/${circleId}/students`).send({ studentId: student.id }).expect(204);
    return { teacher, circleId, student };
  }

  async function newSession(room: Awaited<ReturnType<typeof classroom>>) {
    const { body } = await room.teacher.client
      .post('/v1/teacher/sessions')
      .send({ kind: 'RECITATION', title: 'سورة الملك كاملة', studentId: room.student.id, scheduledAt: new Date(Date.now() + 60_000).toISOString() })
      .expect(201);
    return (body as { id: string }).id;
  }

  const connect = () =>
    new Promise<Client>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/voice`);
      const client = new Client(socket);
      socket.once('open', () => resolve(client));
      socket.once('error', reject);
    });

  const studentTicket = (token: string, id: string) => t.http().post(`/v1/me/sessions/${id}/voice-ticket`).set(bearer(token));

  /** Both sides in the room, in the order a real call usually happens. */
  async function liveCall() {
    const room = await classroom();
    const id = await newSession(room);
    await room.teacher.client.post(`/v1/teacher/sessions/${id}/start`).expect(200);
    const teacherTicket = (await room.teacher.client.post(`/v1/teacher/sessions/${id}/voice-ticket`).expect(200)).body as { ticket: string };
    const teacher = await connect();
    teacher.send({ type: 'join', ticket: teacherTicket.ticket });
    expect(await teacher.next()).toEqual({ type: 'joined', role: 'TEACHER', peerPresent: false, peerMuted: false });

    const ticket = (await studentTicket(room.student.accessToken, id).expect(200)).body as { ticket: string };
    const student = await connect();
    student.send({ type: 'join', ticket: ticket.ticket });
    expect(await student.next()).toEqual({ type: 'joined', role: 'STUDENT', peerPresent: true, peerMuted: false });
    expect(await teacher.next()).toEqual({ type: 'peer-joined' });
    return { room, id, teacher, student, usedTicket: ticket.ticket };
  }

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0);
    port = (t.app.getHttpServer().address() as AddressInfo).port;
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

  describe('attendance sheet', () => {
    it('lists the circle for today, keeps one record per day, and the student sees it', async () => {
      const room = await classroom();
      const sheet = async () =>
        (await room.teacher.client.get('/v1/teacher/attendance').expect(200)).body as {
          circles: { id: string; students: { id: string; attendance: string | null }[] }[];
        };
      expect((await sheet()).circles[0].students).toEqual([expect.objectContaining({ id: room.student.id, attendance: null })]);

      const save = (attendance: string) =>
        room.teacher.client.post('/v1/teacher/attendance/sheet').send({ entries: [{ studentId: room.student.id, attendance }] });
      await save('LATE').expect(204);
      await save('EXCUSED').expect(204);
      expect((await sheet()).circles[0].students[0].attendance).toBe('EXCUSED');
      expect(await t.prisma.evaluation.count({ where: { studentId: room.student.id, title: 'حضور' } })).toBe(1);

      // The form for one student corrects the same day's record instead of adding another.
      await room.teacher.client.post('/v1/teacher/attendance').send({ studentId: room.student.id, attendance: 'PRESENT' }).expect(201);
      expect(await t.prisma.evaluation.count({ where: { studentId: room.student.id, title: 'حضور' } })).toBe(1);

      const circle = (await t.http().get('/v1/me/circle').set(bearer(room.student.accessToken)).expect(200)).body as { todayAttendance: string };
      expect(circle.todayAttendance).toBe('PRESENT');
    });

    it('saves nothing when any student is outside the teacher\'s circles', async () => {
      const mine = await classroom();
      const other = await classroom();
      await mine.teacher.client
        .post('/v1/teacher/attendance/sheet')
        .send({ entries: [{ studentId: mine.student.id, attendance: 'PRESENT' }, { studentId: other.student.id, attendance: 'ABSENT' }] })
        .expect(404);
      expect(await t.prisma.evaluation.count({ where: { studentId: { in: [mine.student.id, other.student.id] } } })).toBe(0);
      await mine.teacher.client
        .post('/v1/teacher/attendance/sheet')
        .send({ entries: [{ studentId: mine.student.id, attendance: 'PRESENT' }, { studentId: mine.student.id, attendance: 'ABSENT' }] })
        .expect(400);
    });
  });

  describe('voice room', () => {
    it('gives a ticket only for the student\'s own session, once it has started', async () => {
      const room = await classroom();
      const id = await newSession(room);
      await studentTicket(room.student.accessToken, id).expect(409);
      await room.teacher.client.post(`/v1/teacher/sessions/${id}/voice-ticket`).expect(409);
      await room.teacher.client.post(`/v1/teacher/sessions/${id}/start`).expect(200);

      const stranger = await newStudent();
      await studentTicket(stranger.accessToken, id).expect(404);
      const otherTeacher = await newStaff('TEACHER');
      await otherTeacher.client.post(`/v1/teacher/sessions/${id}/voice-ticket`).expect(404);

      const { body } = await studentTicket(room.student.accessToken, id).expect(200);
      expect(body).toMatchObject({ ticket: expect.any(String), iceServers: [{ urls: expect.any(Array) }] });
    });

    it('carries the call setup between the two sides only, in the allowed direction', async () => {
      const { teacher, student } = await liveCall();

      teacher.send({ type: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
      expect(await student.next()).toEqual({ type: 'signal', data: { kind: 'offer', sdp: 'v=0 offer' } });
      student.send({ type: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
      expect(await teacher.next()).toEqual({ type: 'signal', data: { kind: 'answer', sdp: 'v=0 answer' } });
      student.send({ type: 'signal', data: { kind: 'ice', candidate: { candidate: 'x', sdpMid: '0', sdpMLineIndex: 0 } } });
      expect(await teacher.next()).toMatchObject({ type: 'signal', data: { kind: 'ice' } });

      student.send({ type: 'mute', muted: true });
      expect(await teacher.next()).toEqual({ type: 'peer-mute', muted: true });

      // Only the teacher offers. Anything else closes the connection, and the other side learns it left.
      student.send({ type: 'signal', data: { kind: 'offer', sdp: 'v=0' } });
      expect(await student.next()).toEqual({ type: 'error', code: 'invalid_message' });
      expect(await student.closed).toBe(4000);
      expect(await teacher.next()).toEqual({ type: 'peer-left' });
      teacher.socket.close();
    });

    it('refuses a made-up, reused or malformed join', async () => {
      const made = await connect();
      made.send({ type: 'join', ticket: 'made-up' });
      expect(await made.next()).toEqual({ type: 'error', code: 'invalid_ticket' });

      const { teacher, student, usedTicket } = await liveCall();
      const again = await connect();
      again.send({ type: 'join', ticket: usedTicket });
      expect(await again.next()).toEqual({ type: 'error', code: 'invalid_ticket' });

      const garbage = await connect();
      garbage.socket.send('not json');
      expect(await garbage.next()).toEqual({ type: 'error', code: 'invalid_message' });

      const early = await connect();
      early.send({ type: 'mute', muted: true });
      expect(await early.next()).toEqual({ type: 'error', code: 'not_joined' });
      teacher.socket.close();
      student.socket.close();
    });

    it('ends for both sides when the teacher ends it, and nobody can come back', async () => {
      const { room, id, teacher, student } = await liveCall();
      await room.teacher.client.post(`/v1/teacher/sessions/${id}/end`).expect(200);
      expect(await teacher.next()).toEqual({ type: 'session-ended' });
      expect(await student.next()).toEqual({ type: 'session-ended' });
      await Promise.all([teacher.closed, student.closed]);
      await studentTicket(room.student.accessToken, id).expect(409);
    });

    it('lets a dropped student rejoin with a new ticket', async () => {
      const { room, id, teacher, student } = await liveCall();
      student.socket.close();
      expect(await teacher.next()).toEqual({ type: 'peer-left' });

      const ticket = (await studentTicket(room.student.accessToken, id).expect(200)).body as { ticket: string };
      const back = await connect();
      back.send({ type: 'join', ticket: ticket.ticket });
      expect(await back.next()).toMatchObject({ type: 'joined', peerPresent: true });
      expect(await teacher.next()).toEqual({ type: 'peer-joined' });
      teacher.socket.close();
      back.socket.close();
    });
  });

  it('tells the student when a session starts, and the alert opens the session', async () => {
    const room = await classroom();
    const id = await newSession(room);
    await room.teacher.client.post(`/v1/teacher/sessions/${id}/start`).expect(200);

    const list = async () =>
      (await t.http().get('/v1/me/notifications').set(bearer(room.student.accessToken)).expect(200)).body as { title: string; opens: string | null; readAt: string | null }[];
    const started = (await list()).find(({ title }) => title === 'بدأت جلستك الآن');
    expect(started).toMatchObject({ opens: 'session', readAt: null });

    await t.http().post('/v1/me/notifications/read-all').set(bearer(room.student.accessToken)).expect(204);
    expect((await list()).every(({ readAt }) => readAt !== null)).toBe(true);

    const circle = (await t.http().get('/v1/me/circle').set(bearer(room.student.accessToken)).expect(200)).body as { nextSession: object };
    expect(circle.nextSession).toMatchObject({ id, status: 'IN_PROGRESS', individual: true });
  });

  it('issues a certificate only for a finished track, with a date that doesn\'t move', async () => {
    const student = await newStudent();
    const board = async () =>
      (await t.http().get('/v1/me/badge-board').set(bearer(student.accessToken)).expect(200)).body as {
        certificate: { studentName: string; trackName: string; section: string; completedAt: string } | null;
      };
    expect((await board()).certificate).toBeNull();

    const completedAt = new Date('2026-01-15T10:00:00Z');
    await t.prisma.studentPlan.update({ where: { studentId: student.id }, data: { status: 'COMPLETED', completedAt } });
    expect((await board()).certificate).toEqual({
      studentName: 'نورة محمد العتيبي',
      trackName: 'مسار الحفظ المتأني',
      section: 'WOMEN',
      completedAt: completedAt.toISOString(),
    });
  });
});
