import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { NotificationType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { absenceLevel, DAY_MS } from './plan-engine.js';
import { SettingsService } from './settings.service.js';

export type Audience =
  | { type: 'ALL' }
  | { type: 'TRACK'; trackTemplateId: string }
  | { type: 'CIRCLE'; circleId: string }
  | { type: 'SCOPE'; scopeId: string };

const SESSION_NOTICE_MS = 2 * 60 * 60 * 1000;
const FALLBACK_TIME_ZONE = 'Asia/Riyadh';
const ENCOURAGEMENT_DAY = 6;
const ENCOURAGEMENT_MINUTES = 9 * 60;
/** Far enough back to cover the whole of "today" on any clock in the world. */
const LOOK_BACK_MS = 2 * DAY_MS;

const ABSENCE_MESSAGES: Record<1 | 2 | 3, { title: string; body: string }> = {
  1: { title: 'بنيتنا، افتقدنا حضورك', body: 'نسأل الله أن تكوني بخير، وننتظر عودتك إلى حلقتك.' },
  2: { title: 'طالت غيبتك', body: 'تكرر غيابك عن الحلقة، فبادري بالعودة والتواصل مع معلمتك.' },
  3: { title: 'إنذار لكثرة التسيب', body: 'كثر غيابك عن الحلقة، وقد يؤثر ذلك في بقائك في البرنامج.' },
};

interface Message {
  type: NotificationType;
  title: string;
  body: string;
  dedupeKey?: string;
}

export interface LocalClock {
  /** YYYY-MM-DD on the student's own calendar. */
  date: string;
  /** Sunday is 0. */
  weekday: number;
  /** Minutes since the student's own midnight. */
  minutes: number;
  dayStart: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A zone name saved long ago may no longer exist, and that must not stop anyone else's reminders. */
export function localClock(timeZone: string | null, now: Date): LocalClock {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(timeZone ?? FALLBACK_TIME_ZONE);
  } catch {
    formatter = formatterFor(FALLBACK_TIME_ZONE);
  }
  const parts = formatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  const seconds = Number(part('hour')) * 3600 + Number(part('minute')) * 60 + Number(part('second'));
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: WEEKDAYS.indexOf(part('weekday')),
    minutes: Math.floor(seconds / 60),
    dayStart: new Date(now.getTime() - seconds * 1000),
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Active students in the audience. A student's own notification settings apply in send(). */
  async resolve(audience: Audience): Promise<string[]> {
    const student = { role: 'STUDENT' as const, status: 'ACTIVE' as const };
    const where =
      audience.type === 'ALL'
        ? student
        : audience.type === 'TRACK'
          ? { ...student, trackTemplateId: audience.trackTemplateId }
          : audience.type === 'CIRCLE'
            ? { ...student, memberships: { some: { leftAt: null, circleId: audience.circleId } } }
            : { ...student, memberships: { some: { leftAt: null, circle: { scopeId: audience.scopeId } } } };
    const rows = await this.prisma.user.findMany({ where, select: { id: true } });
    return rows.map(({ id }) => id);
  }

  /** Stores what each person sees in the app, and returns how many it reached. */
  async send(userIds: string[], message: Message): Promise<number> {
    if (userIds.length === 0) return 0;
    const optedOut = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: userIds }, type: message.type, enabled: false },
      select: { userId: true },
    });
    const skip = new Set(optedOut.map(({ userId }) => userId));
    const data = userIds.filter((id) => !skip.has(id)).map((userId) => ({ userId, ...message }));
    if (data.length === 0) return 0;
    // The dedupe key means a repeat of the same message to the same person does nothing.
    const { count } = await this.prisma.notification.createMany({ data, skipDuplicates: true });
    return count;
  }

  /** Tells the teacher of the student's current circle, if there is one. */
  async notifyTeacherOf(studentId: string, message: Message): Promise<void> {
    const membership = await this.prisma.circleMembership.findFirst({
      where: { studentId, leftAt: null },
      select: { circle: { select: { teacherId: true } } },
    });
    if (membership?.circle.teacherId) await this.send([membership.circle.teacherId], message);
  }

  async inbox(userId: string) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, type: true, title: true, body: true, readAt: true, createdAt: true, dedupeKey: true },
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      unread,
      items: items.map(({ dedupeKey, ...item }) => ({
        ...item,
        /** The dashboard page this notice is about, under the role's own path. */
        opens: dedupeKey?.startsWith('task-done') ? 'tasks' : dedupeKey?.startsWith('gate-ready') || dedupeKey?.startsWith('request') ? 'approvals' : null,
      })),
    };
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  }

  /** One student, or the whole circle for a session with no one student. */
  private async sessionAudience(session: { studentId: string | null; circleId: string | null }): Promise<string[]> {
    if (session.studentId) return [session.studentId];
    return session.circleId ? this.resolve({ type: 'CIRCLE', circleId: session.circleId }) : [];
  }

  async sessionStarted(session: { id: string; title: string; studentId: string | null; circleId: string | null }): Promise<void> {
    await this.send(await this.sessionAudience(session), {
      type: 'GENERAL',
      title: 'بدأت جلستك الآن',
      body: session.title,
      dedupeKey: `session-start:${session.id}`,
    });
  }

  /** Two hours before a session. The dedupe key means each student hears once, however often this runs. */
  @Cron('*/5 * * * *')
  async sendSessionReminders(): Promise<void> {
    const now = new Date();
    const sessions = await this.prisma.liveSession.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gt: now, lte: new Date(now.getTime() + SESSION_NOTICE_MS) } },
      select: { id: true, title: true, studentId: true, circleId: true },
    });
    for (const session of sessions) {
      await this.send(await this.sessionAudience(session), {
        type: 'GENERAL',
        title: 'تقترب جلستك',
        body: `خلال ساعتين: ${session.title}`,
        dedupeKey: `session-soon:${session.id}`,
      });
    }
  }

  /** Each date's message goes to the students for whom it is that date now. */
  private async sendByLocalDate(due: Map<string, string[]>, message: (date: string) => Message): Promise<number> {
    let reached = 0;
    for (const [date, ids] of due) reached += await this.send(ids, message(date));
    return reached;
  }

  /** At the student's chosen time, to those whose wird today is still open. A student waiting at a gate has none. */
  @Cron('*/5 * * * *')
  async sendWirdReminders(now = new Date()): Promise<number> {
    const plans = await this.prisma.studentPlan.findMany({
      where: { status: 'ACTIVE', student: { status: 'ACTIVE', gates: { none: { status: 'PENDING' } } } },
      select: {
        studentId: true,
        template: { select: { wirdDays: true } },
        student: { select: { timeZone: true, reminderMinutes: true } },
        logs: { where: { createdAt: { gte: new Date(now.getTime() - LOOK_BACK_MS) } }, select: { createdAt: true } },
      },
    });
    const due = new Map<string, string[]>();
    for (const plan of plans) {
      const clock = localClock(plan.student.timeZone, now);
      if (clock.minutes < plan.student.reminderMinutes || !plan.template.wirdDays.includes(clock.weekday)) continue;
      if (plan.logs.some(({ createdAt }) => createdAt >= clock.dayStart)) continue;
      due.set(clock.date, [...(due.get(clock.date) ?? []), plan.studentId]);
    }
    return this.sendByLocalDate(due, (date) => ({
      type: 'DAILY_WIRD',
      title: 'تذكير بورد اليوم',
      body: 'لم يكتمل وردك اليوم بعد، أعانك الله.',
      dedupeKey: `wird:${date}`,
    }));
  }

  /** At the student's chosen time on the track's review days, to those who haven't recorded today's review. */
  @Cron('*/5 * * * *')
  async sendReviewReminders(now = new Date()): Promise<number> {
    const plans = await this.prisma.studentPlan.findMany({
      where: { status: 'ACTIVE', student: { status: 'ACTIVE' } },
      select: {
        studentId: true,
        template: { select: { wirdDays: true } },
        student: {
          select: {
            timeZone: true,
            reminderMinutes: true,
            dayCompletions: { where: { kind: 'REVIEW', createdAt: { gte: new Date(now.getTime() - LOOK_BACK_MS) } }, select: { createdAt: true } },
          },
        },
      },
    });
    const due = new Map<string, string[]>();
    for (const plan of plans) {
      const clock = localClock(plan.student.timeZone, now);
      if (clock.minutes < plan.student.reminderMinutes || plan.template.wirdDays.includes(clock.weekday)) continue;
      if (plan.student.dayCompletions.some(({ createdAt }) => createdAt >= clock.dayStart)) continue;
      due.set(clock.date, [...(due.get(clock.date) ?? []), plan.studentId]);
    }
    return this.sendByLocalDate(due, (date) => ({
      type: 'WEEKLY_REVIEW',
      title: 'تذكير بالمراجعة الأسبوعية',
      body: 'اليوم يوم مراجعة، فاكتبي سور مراجعتك وعوّضي ما فاتك.',
      dedupeKey: `review:${date}`,
    }));
  }

  /** Saturday morning on each student's own clock. */
  @Cron('*/5 * * * *')
  async sendWeeklyEncouragement(now = new Date()): Promise<number> {
    const { encouragementEnabled } = await this.settings.get('features');
    if (!encouragementEnabled) return 0;

    const messages = await this.prisma.encouragementMessage.findMany({ select: { text: true } });
    if (messages.length === 0) return 0;
    const { text } = messages[Math.floor(Math.random() * messages.length)];

    const students = await this.prisma.user.findMany({
      where: { role: 'STUDENT', status: 'ACTIVE', admissionStatus: 'ACCEPTED' },
      select: { id: true, timeZone: true },
    });
    const due = new Map<string, string[]>();
    for (const student of students) {
      const clock = localClock(student.timeZone, now);
      if (clock.weekday !== ENCOURAGEMENT_DAY || clock.minutes < ENCOURAGEMENT_MINUTES) continue;
      due.set(clock.date, [...(due.get(clock.date) ?? []), student.id]);
    }
    return this.sendByLocalDate(due, (date) => ({
      type: 'ENCOURAGEMENT',
      title: 'رسالة تشجيعية',
      body: text,
      dedupeKey: `encouragement:${date}`,
    }));
  }

  /**
   * Called when attendance is recorded. Each warning is sent once, and a higher level sends its own.
   * Attending again closes the warnings, so a later run of absences starts from the beginning.
   */
  async checkAbsence(studentId: string): Promise<void> {
    const rows = await this.prisma.evaluation.findMany({
      where: { studentId, attendance: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { attendance: true },
    });
    const level = absenceLevel(rows.flatMap(({ attendance }) => (attendance ? [attendance] : [])));
    if (level === null) {
      await this.prisma.absenceWarning.updateMany({ where: { studentId, resolvedAt: null }, data: { resolvedAt: new Date() } });
      return;
    }
    const open = await this.prisma.absenceWarning.findFirst({
      where: { studentId, resolvedAt: null },
      orderBy: { level: 'desc' },
      select: { level: true },
    });
    if (open && open.level >= level) return;

    const warning = await this.prisma.absenceWarning.create({ data: { studentId, level }, select: { id: true } });
    await this.send([studentId], { type: 'GENERAL', ...ABSENCE_MESSAGES[level], dedupeKey: `absence:${warning.id}` });
  }
}
