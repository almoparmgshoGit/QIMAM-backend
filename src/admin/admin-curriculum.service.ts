import { Injectable } from '@nestjs/common';
import { parse as parseCsv } from 'csv-parse/sync';
import { randomBytes, randomInt } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import { randomId } from '../common/ids.js';
import { attendanceRate, isUniqueViolation, pageArgs, riyadhDayStart } from '../common/staff-api.js';
import { SURAHS, findSurah } from '../common/surahs.js';
import type { AttendanceStatus } from '../generated/prisma/enums.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type Audience, NotificationsService } from '../program/notifications.service.js';
import { DEFAULT_WIRD_STEPS } from '../program/plan-engine.js';
import { PlanService } from '../program/plan.service.js';
import { type SettingKey, SettingsService, type SettingValue } from '../program/settings.service.js';
import { announcementStatus } from '../supervisor/supervisor-program.service.js';
import type {
  CreateBadgeDto,
  CreateBroadcastDto,
  CreateExceptionDto,
  CreateTrackDto,
  InfoPageDto,
  ListBroadcastsDto,
  TadabburDto,
  UpdateTrackDto,
  UploadTranslationDto,
} from './admin-curriculum.schemas.js';

const notFound = () => new ApiError(404, 'not_found');

/** A new step gets an id no earlier step used, so a student's finished steps never attach to it. */
const withStepIds = (steps: NonNullable<UpdateTrackDto['wirdSteps']>) =>
  steps.map((step) => ({ ...step, id: step.id ?? randomInt(1_000, 2_000_000_000) }));

// The codes PlanService awards when a student passes a surah or finishes their track.
const AUTOMATIC_BADGE_CODES = { SURAH_PASSED: 'surahComplete', TRACK_COMPLETED: 'quranCompanion' } as const;
const TOTAL_AYAHS = SURAHS.reduce((sum, surah) => sum + surah.ayahCount, 0);
const VERSE_BATCH = 1000;
const MAX_VERSE_LENGTH = 4000;
const MAX_LANGUAGE_KEYS = 5000;
// Translations are shown as plain text, so markup in one means the file is wrong or hostile.
const MARKUP = /<[a-z/!][^>]*>/i;
const DEFAULT_ORDER = (() => {
  const numbers = SURAHS.map((surah) => surah.number);
  return [...numbers.slice(17), ...numbers.slice(0, 17)];
})();

const verseSchema = z.object({
  surah: z.coerce.number().int().min(1).max(114),
  ayah: z.coerce.number().int().min(1),
  text: z.string().trim().min(1).max(MAX_VERSE_LENGTH),
});
const languagePackSchema = z.record(z.string().max(200), z.string().max(2000));

@Injectable()
export class AdminCurriculumService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly plans: PlanService,
  ) {}

  // ---------- Tracks ----------

  async listTracks() {
    const [tracks, enrollment] = await Promise.all([
      this.prisma.trackTemplate.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.user.groupBy({
        by: ['trackTemplateId', 'section'],
        where: { role: 'STUDENT', status: 'ACTIVE', trackTemplateId: { not: null } },
        _count: true,
      }),
    ]);
    return tracks.map(({ surahOrder: _order, ...track }) => {
      const rows = enrollment.filter((row) => row.trackTemplateId === track.id);
      return {
        ...track,
        wirdSteps: track.wirdSteps ?? DEFAULT_WIRD_STEPS,
        reviewDays: [0, 1, 2, 3, 4, 5, 6].filter((day) => !track.wirdDays.includes(day)),
        enrollment: {
          total: rows.reduce((sum, row) => sum + row._count, 0),
          women: rows.find((row) => row.section === 'WOMEN')?._count ?? 0,
          men: rows.find((row) => row.section === 'MEN')?._count ?? 0,
        },
      };
    });
  }

  async createTrack(admin: StaffActor, dto: CreateTrackDto) {
    const track = await this.prisma.trackTemplate.create({
      data:
        dto.kind === 'MEMORIZATION'
          ? { ...dto, wirdSteps: dto.wirdSteps && withStepIds(dto.wirdSteps), code: randomId(), surahOrder: DEFAULT_ORDER, gateMode: 'ACTIVE' }
          : { ...dto, code: randomId(), surahOrder: [], wirdDays: [], gateMode: 'PAUSED' },
      select: { id: true },
    });
    await this.audit.record(admin, 'track.create', { type: 'track', id: track.id });
    return track;
  }

  /** Plans read their rules from here, so a change reaches every student on the track at once. */
  async updateTrack(admin: StaffActor, id: string, dto: UpdateTrackDto) {
    const track = await this.prisma.trackTemplate.findUnique({ where: { id }, select: { kind: true, dailyUnit: true } });
    if (!track) throw notFound();

    const memorizationOnly = dto.dailyUnit ?? dto.wirdDays ?? dto.consolidationDays ?? dto.wirdSteps ?? dto.repeatTarget ?? dto.reviewTarget ?? dto.encouragements;
    const correctionOnly = dto.focus ?? dto.sessionsPerWeek ?? dto.application;
    if (track.kind === 'CORRECTION' ? memorizationOnly !== undefined : correctionOnly !== undefined) {
      throw new ApiError(400, 'field_not_for_this_track');
    }
    // A track's rules apply to everyone on it, including students who have already started.
    const { dailyUnit: from } = track;
    const { dailyUnit: to } = dto;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.trackTemplate.update({ where: { id }, data: { ...dto, wirdSteps: dto.wirdSteps && withStepIds(dto.wirdSteps) } });
        if (from && to && from !== to) await this.plans.changeDailyUnit(id, from, to, tx);
      },
      { timeout: 60_000 },
    );
    await this.audit.record(admin, 'track.update', { type: 'track', id }, { active: dto.active ?? null });
  }

  // ---------- Gate rules ----------

  async gateRules() {
    const [conditions, tracks] = await Promise.all([
      this.settings.get('gate'),
      this.prisma.trackTemplate.findMany({
        where: { kind: 'MEMORIZATION' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, gateMode: true },
      }),
    ]);
    return { conditions, tracks };
  }

  async setGateMode(admin: StaffActor, trackId: string, mode: 'ACTIVE' | 'RELAXED' | 'TEACHER' | 'PAUSED') {
    const { count } = await this.prisma.trackTemplate.updateMany({ where: { id: trackId, kind: 'MEMORIZATION' }, data: { gateMode: mode } });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'gate.set_mode', { type: 'track', id: trackId }, { mode });
  }

  async listExceptions() {
    const rows = await this.prisma.gateException.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, type: true, reason: true, expiresAt: true, student: { select: { id: true, fullName: true } } },
    });
    return rows.map(({ student, ...row }) => ({ ...row, student: { id: student.id, name: student.fullName } }));
  }

  async createException(admin: StaffActor, dto: CreateExceptionDto) {
    const student = await this.prisma.user.findFirst({ where: { id: dto.studentId, role: 'STUDENT' }, select: { id: true } });
    if (!student) throw notFound();
    const row = await this.prisma.gateException.create({
      data: { ...dto, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null, createdById: admin.id },
      select: { id: true },
    });
    await this.audit.record(admin, 'gate.add_exception', { type: 'student', id: dto.studentId }, { type: dto.type });
    return row;
  }

  async removeException(admin: StaffActor, id: string): Promise<void> {
    const { count } = await this.prisma.gateException.deleteMany({ where: { id } });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'gate.remove_exception', { type: 'exception', id });
  }

  // ---------- Tadabbur ----------

  async listTadabbur() {
    const rows = await this.prisma.surahTadabbur.findMany({ select: { surah: true, published: true, link: true, _count: { select: { tasks: true } } } });
    return SURAHS.map(({ number, name }) => {
      const row = rows.find((item) => item.surah === number);
      return { surah: number, name, status: !row ? 'empty' : row.published ? 'complete' : 'draft', tasks: row?._count.tasks ?? 0 };
    });
  }

  async getTadabbur(surah: number) {
    const content = await this.prisma.surahTadabbur.findUnique({
      where: { surah },
      include: { tasks: { orderBy: { position: 'asc' }, select: { id: true, title: true, note: true } } },
    });
    return { surah, name: findSurah(surah)?.name ?? null, content };
  }

  async saveTadabbur(admin: StaffActor, surah: number, { tasks, ...content }: TadabburDto) {
    if (content.published && (tasks.length === 0 || !content.link)) throw new ApiError(400, 'incomplete_content');

    await this.prisma.$transaction(async (tx) => {
      await tx.surahTadabbur.upsert({ where: { surah }, create: { surah, ...content }, update: content });
      const keep = tasks.flatMap(({ id }) => (id ? [id] : []));
      // Only this surah's tasks can be touched, whatever ids arrive.
      await tx.tadabburTask.deleteMany({ where: { surah, id: { notIn: keep } } });
      for (const [position, task] of tasks.entries()) {
        if (task.id) {
          const { count } = await tx.tadabburTask.updateMany({
            where: { id: task.id, surah },
            data: { title: task.title, note: task.note, position },
          });
          if (count !== 1) throw notFound();
        } else {
          await tx.tadabburTask.create({ data: { surah, title: task.title, note: task.note, position } });
        }
      }
    });
    await this.audit.record(admin, 'tadabbur.save', { type: 'surah', id: String(surah) }, { published: content.published });
    return this.getTadabbur(surah);
  }

  // ---------- Quran content ----------

  async quranContent() {
    const translations = await this.prisma.translation.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, language: true, source: true, fileName: true, status: true, updatedAt: true },
    });
    return {
      facts: { surahs: SURAHS.length, pages: 604, juz: 30, halfPages: 1208, ayahs: TOTAL_AYAHS },
      translations,
    };
  }

  /** Nothing is saved unless the whole file is sound and covers every ayah exactly once. */
  async uploadTranslation(admin: StaffActor, dto: UploadTranslationDto, file: { originalname: string; buffer: Buffer } | undefined) {
    if (!file) throw new ApiError(400, 'file_required');
    const verses = this.parseTranslation(file);

    const translationId = randomId();
    await this.prisma.$transaction(
      async (tx) => {
        await tx.translation.create({
          data: { id: translationId, language: dto.language, source: dto.source, fileName: basename(file.originalname).slice(0, 200) },
        });
        for (let start = 0; start < verses.length; start += VERSE_BATCH) {
          await tx.translationVerse.createMany({
            data: verses.slice(start, start + VERSE_BATCH).map((verse) => ({ translationId, ...verse })),
          });
        }
      },
      { timeout: 120_000 },
    );
    await this.audit.record(admin, 'translation.upload', { type: 'translation', id: translationId }, { verses: verses.length });
    return { id: translationId, verses: verses.length, status: 'REVIEW' };
  }

  async previewTranslation(id: string, surah: number, ayah: number) {
    const verse = await this.prisma.translationVerse.findUnique({
      where: { translationId_surah_ayah: { translationId: id, surah, ayah } },
      select: { surah: true, ayah: true, text: true },
    });
    if (!verse) throw notFound();
    return { ...verse, surahName: findSurah(surah)?.name ?? null };
  }

  /** One approved translation per language: approving replaces the last, and a rejected file's text is removed. */
  async decideTranslation(admin: StaffActor, id: string, approve: boolean): Promise<void> {
    const translation = await this.prisma.translation.findFirst({ where: { id, status: 'REVIEW' }, select: { language: true } });
    if (!translation) throw notFound();

    await this.prisma.$transaction(async (tx) => {
      if (approve) {
        await tx.translation.updateMany({
          where: { language: translation.language, status: 'APPROVED' },
          data: { status: 'REJECTED' },
        });
        await tx.translation.update({ where: { id }, data: { status: 'APPROVED' } });
      } else {
        await tx.translation.update({ where: { id }, data: { status: 'REJECTED' } });
        await tx.translationVerse.deleteMany({ where: { translationId: id } });
      }
    });
    await this.audit.record(admin, approve ? 'translation.approve' : 'translation.reject', { type: 'translation', id });
  }

  private parseTranslation(file: { originalname: string; buffer: Buffer }) {
    const invalid = (reason: string) => new ApiError(400, reason);
    const name = file.originalname.toLowerCase();
    let rows: unknown;
    try {
      const text = file.buffer.toString('utf8').replace(/^﻿/, '');
      if (name.endsWith('.json')) rows = JSON.parse(text);
      else if (name.endsWith('.csv')) rows = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true });
      else throw invalid('unsupported_file_type');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw invalid('unreadable_file');
    }

    const parsed = z.array(verseSchema).safeParse(rows);
    if (!parsed.success) throw invalid('invalid_translation_rows');

    const seen = new Set<string>();
    for (const { surah, ayah, text } of parsed.data) {
      const key = `${surah}:${ayah}`;
      if (seen.has(key) || ayah > SURAHS[surah - 1].ayahCount) throw invalid('invalid_ayah_reference');
      if (MARKUP.test(text)) throw invalid('markup_not_allowed');
      seen.add(key);
    }
    if (seen.size !== TOTAL_AYAHS) throw invalid('incomplete_translation');
    return parsed.data;
  }

  // ---------- Settings ----------

  async settingsOverview() {
    const [features, permissions, pledges, admission, pages, packs] = await Promise.all([
      this.settings.get('features'),
      this.settings.get('permissions'),
      this.settings.get('pledges'),
      this.settings.get('admission'),
      this.prisma.infoPage.findMany({ orderBy: { slug: 'asc' } }),
      this.prisma.languagePack.findMany({ select: { code: true, updatedAt: true } }),
    ]);
    return { features, permissions, pledges, admission, pages, languagePacks: packs };
  }

  async saveSetting<K extends SettingKey>(admin: StaffActor, key: K, value: SettingValue<K>): Promise<void> {
    await this.settings.set(key, value);
    await this.audit.record(admin, 'settings.update', { type: 'setting', id: key }, { ...(value as object) });
  }

  /** New wording is a new version, so what each student agreed to stays on record. */
  async savePledges(admin: StaffActor, items: string[]): Promise<void> {
    const { version } = await this.settings.get('pledges');
    await this.saveSetting(admin, 'pledges', { version: version + 1, items });
  }

  async createInfoPage(admin: StaffActor, dto: InfoPageDto) {
    const { slug } = await this.prisma.infoPage.create({
      data: { ...dto, slug: `page-${randomBytes(8).toString('hex')}` },
      select: { slug: true },
    });
    await this.audit.record(admin, 'info_page.create', { type: 'info_page', id: slug });
    return { slug };
  }

  async saveInfoPage(admin: StaffActor, slug: string, dto: InfoPageDto) {
    const { count } = await this.prisma.infoPage.updateMany({ where: { slug }, data: dto });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'info_page.update', { type: 'info_page', id: slug });
  }

  async uploadLanguagePack(admin: StaffActor, code: string, file: { originalname: string; buffer: Buffer } | undefined) {
    if (!file) throw new ApiError(400, 'file_required');
    if (!file.originalname.toLowerCase().endsWith('.json')) throw new ApiError(400, 'unsupported_file_type');

    let content: unknown;
    try {
      content = JSON.parse(file.buffer.toString('utf8').replace(/^﻿/, ''));
    } catch {
      throw new ApiError(400, 'unreadable_file');
    }
    const parsed = languagePackSchema.safeParse(content);
    if (!parsed.success || Object.keys(parsed.data).length > MAX_LANGUAGE_KEYS) throw new ApiError(400, 'invalid_language_file');
    if (Object.values(parsed.data).some((text) => MARKUP.test(text))) throw new ApiError(400, 'markup_not_allowed');

    await this.prisma.languagePack.upsert({ where: { code }, create: { code, content: parsed.data }, update: { content: parsed.data } });
    await this.audit.record(admin, 'language_pack.upload', { type: 'language', id: code }, { keys: Object.keys(parsed.data).length });
    return { keys: Object.keys(parsed.data).length };
  }

  // ---------- Motivation ----------

  async motivation() {
    const month = new Date().toISOString().slice(0, 7);
    const [badges, messages, features, members, certificates] = await Promise.all([
      this.prisma.badge.findMany({
        orderBy: { code: 'asc' },
        select: { id: true, code: true, label: true, condition: true, icon: true, _count: { select: { awards: true } } },
      }),
      this.prisma.encouragementMessage.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, text: true } }),
      this.settings.get('features'),
      this.prisma.circleMembership.findMany({
        where: { leftAt: null, circle: { archivedAt: null } },
        select: { studentId: true, circle: { select: { id: true, name: true, honoredMonth: true, teacher: { select: { fullName: true } } } } },
      }),
      this.prisma.studentPlan.findMany({
        where: { status: 'COMPLETED' },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: { updatedAt: true, completedAt: true, template: { select: { name: true } }, student: { select: { id: true, fullName: true, section: true } } },
      }),
    ]);

    const summaries = await this.plans.summaries(members.map(({ studentId }) => studentId));
    const circles = new Map<string, { id: string; name: string; teacher: string | null; honored: boolean; values: number[] }>();
    for (const { studentId, circle } of members) {
      const entry = circles.get(circle.id) ?? {
        id: circle.id,
        name: circle.name,
        teacher: circle.teacher?.fullName ?? null,
        honored: circle.honoredMonth === month,
        values: [],
      };
      const commitment = summaries.get(studentId)?.commitment;
      if (commitment !== null && commitment !== undefined) entry.values.push(commitment);
      circles.set(circle.id, entry);
    }

    return {
      badges: badges.map(({ _count, ...badge }) => ({ ...badge, awarded: _count.awards })),
      messages,
      messagesEnabled: features.encouragementEnabled,
      certificates: certificates.map(({ updatedAt, completedAt, template, student }) => ({
        studentId: student.id,
        studentName: student.fullName,
        section: student.section,
        track: template.name,
        completedAt: completedAt ?? updatedAt,
      })),
      topCircles: [...circles.values()]
        .filter(({ values }) => values.length > 0)
        .map(({ values, ...circle }) => ({
          ...circle,
          commitment: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
        }))
        .sort((a, b) => b.commitment - a.commitment)
        .slice(0, 5),
    };
  }

  async createBadge(admin: StaffActor, { trigger, ...badge }: CreateBadgeDto) {
    try {
      const { id } = await this.prisma.badge.create({
        data: { ...badge, code: trigger === 'MANUAL' ? randomId() : AUTOMATIC_BADGE_CODES[trigger] },
        select: { id: true },
      });
      await this.audit.record(admin, 'badge.create', { type: 'badge', id });
      return { id };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, 'badge_trigger_taken');
      throw error;
    }
  }

  async setBadgeCondition(admin: StaffActor, id: string, condition: string): Promise<void> {
    const { count } = await this.prisma.badge.updateMany({ where: { id }, data: { condition } });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'badge.update', { type: 'badge', id });
  }

  async awardBadge(admin: StaffActor, studentId: string, badgeId: string): Promise<void> {
    const [student, badge] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: studentId, role: 'STUDENT' }, select: { id: true } }),
      this.prisma.badge.findUnique({ where: { id: badgeId }, select: { label: true } }),
    ]);
    if (!student || !badge) throw notFound();
    const { count } = await this.prisma.studentBadge.createMany({ data: [{ studentId, badgeId, awardedById: admin.id }], skipDuplicates: true });
    if (count === 1) {
      await this.notifications.send([studentId], { type: 'BADGES', title: 'شارة جديدة', body: badge.label, dedupeKey: `badge:${badgeId}` });
      await this.audit.record(admin, 'badge.award', { type: 'student', id: studentId }, { badgeId });
    }
  }

  async addMessage(admin: StaffActor, text: string) {
    const { count } = await this.prisma.encouragementMessage.createMany({ data: [{ text }], skipDuplicates: true });
    if (count !== 1) throw new ApiError(409, 'message_exists');
    await this.audit.record(admin, 'encouragement.add', { type: 'setting', id: 'encouragement' });
  }

  async removeMessage(admin: StaffActor, id: string): Promise<void> {
    const { count } = await this.prisma.encouragementMessage.deleteMany({ where: { id } });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'encouragement.remove', { type: 'setting', id: 'encouragement' });
  }

  /** A circle is honored once a month, and its students hear about it. */
  async honorCircle(admin: StaffActor, circleId: string): Promise<void> {
    const month = new Date().toISOString().slice(0, 7);
    const circle = await this.prisma.circle.findFirst({ where: { id: circleId, archivedAt: null }, select: { name: true } });
    if (!circle) throw notFound();
    const { count } = await this.prisma.circle.updateMany({
      where: { id: circleId, OR: [{ honoredMonth: null }, { honoredMonth: { not: month } }] },
      data: { honoredMonth: month },
    });
    if (count !== 1) return;
    await this.notifications.send(await this.notifications.resolve({ type: 'CIRCLE', circleId }), {
      type: 'GENERAL',
      title: 'تكريم حلقتك',
      body: `كُرّمت ${circle.name} هذا الشهر. بارك الله فيكن.`,
      dedupeKey: `honor:${circleId}:${month}`,
    });
    await this.audit.record(admin, 'circle.honor', { type: 'circle', id: circleId });
  }

  // ---------- Announcements and alerts ----------

  async listBroadcasts(query: ListBroadcastsDto) {
    const [total, items] = await Promise.all([
      this.prisma.announcement.count({ where: { kind: query.kind } }),
      this.prisma.announcement.findMany({
        where: { kind: query.kind },
        ...pageArgs(query),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          body: true,
          scope: true,
          startsAt: true,
          endsAt: true,
          recipients: true,
          createdAt: true,
          circle: { select: { id: true, name: true } },
          track: { select: { id: true, name: true } },
          targetScope: { select: { id: true, name: true } },
        },
      }),
    ]);
    return {
      total,
      items: items.map(({ circle, track, targetScope, ...item }) => ({
        ...item,
        audience: circle?.name ?? track?.name ?? targetScope?.name ?? null,
        status: announcementStatus(item),
      })),
    };
  }

  async createBroadcast(admin: StaffActor, dto: CreateBroadcastDto) {
    const audience = await this.resolveAudience(dto.audience);
    const data = {
      kind: dto.kind,
      scope: dto.audience.type,
      trackTemplateId: dto.audience.type === 'TRACK' ? dto.audience.trackId : null,
      circleId: dto.audience.type === 'CIRCLE' ? dto.audience.circleId : null,
      authorId: admin.id,
      title: dto.title,
      body: dto.body,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : new Date(),
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      publishedAt: new Date(),
    };
    const row = await this.prisma.announcement.create({ data, select: { id: true } });

    let recipients: number | null = null;
    if (dto.kind === 'ALERT') {
      recipients = await this.notifications.send(await this.notifications.resolve(audience), {
        type: 'GENERAL',
        title: dto.title,
        body: dto.body,
        dedupeKey: `alert:${row.id}`,
      });
      await this.prisma.announcement.update({ where: { id: row.id }, data: { recipients } });
    }
    await this.audit.record(admin, `${dto.kind.toLowerCase()}.create`, { type: 'announcement', id: row.id });
    return { id: row.id, recipients };
  }

  async endAnnouncement(admin: StaffActor, id: string): Promise<void> {
    const now = new Date();
    const { count } = await this.prisma.announcement.updateMany({
      where: { id, kind: 'ANNOUNCEMENT', OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      data: { endsAt: now },
    });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'announcement.end', { type: 'announcement', id });
  }

  async deleteAnnouncement(admin: StaffActor, id: string): Promise<void> {
    const { count } = await this.prisma.announcement.deleteMany({ where: { id, kind: 'ANNOUNCEMENT' } });
    if (count !== 1) throw notFound();
    await this.audit.record(admin, 'announcement.delete', { type: 'announcement', id });
  }

  private async resolveAudience(audience: CreateBroadcastDto['audience']): Promise<Audience> {
    if (audience.type === 'ALL') return { type: 'ALL' };
    if (audience.type === 'TRACK') {
      const track = await this.prisma.trackTemplate.findUnique({ where: { id: audience.trackId }, select: { id: true } });
      if (!track) throw notFound();
      return { type: 'TRACK', trackTemplateId: track.id };
    }
    const circle = await this.prisma.circle.findFirst({ where: { id: audience.circleId, archivedAt: null }, select: { id: true } });
    if (!circle) throw notFound();
    return { type: 'CIRCLE', circleId: circle.id };
  }

  // ---------- Overview and reports ----------

  async overview() {
    const dayStart = riyadhDayStart();
    const thisMonth = new Date(Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), 1));
    const lastMonth = new Date(Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth() - 1, 1));
    const student = { role: 'STUDENT' as const };

    const [students, newThisMonth, newLastMonth, circles, teachers, byCountry, byTrack, tracks, plans] = await Promise.all([
      this.prisma.user.count({ where: student }),
      this.prisma.user.count({ where: { ...student, createdAt: { gte: thisMonth } } }),
      this.prisma.user.count({ where: { ...student, createdAt: { gte: lastMonth, lt: thisMonth } } }),
      this.prisma.circle.count({ where: { archivedAt: null } }),
      this.prisma.user.count({ where: { role: 'TEACHER', status: 'ACTIVE' } }),
      this.prisma.user.groupBy({ by: ['country'], where: student, _count: true, orderBy: { _count: { country: 'desc' } } }),
      this.prisma.user.groupBy({ by: ['trackTemplateId'], where: student, _count: true }),
      this.prisma.trackTemplate.findMany({ select: { id: true, name: true, kind: true } }),
      this.prisma.studentPlan.findMany({ select: { studentId: true } }),
    ]);

    const summaries = await this.plans.summaries(plans.map(({ studentId }) => studentId));
    const commitments = [...summaries.values()].flatMap(({ commitment }) => (commitment === null ? [] : [commitment]));

    return {
      stats: {
        students,
        newRegistrations: newThisMonth,
        newRegistrationsChange: newThisMonth - newLastMonth,
        circles,
        teachers,
        commitment: commitments.length === 0 ? null : Math.round(commitments.reduce((sum, value) => sum + value, 0) / commitments.length),
      },
      byCountry: byCountry.map((row) => ({ country: row.country, students: row._count })),
      byTrack: tracks.map((track) => {
        const count = byTrack.find((row) => row.trackTemplateId === track.id)?._count ?? 0;
        return {
          id: track.id,
          name: track.name,
          kind: track.kind,
          students: count,
          share: students === 0 ? 0 : Math.round((count / students) * 100),
        };
      }),
    };
  }

  /** Program totals by scope. Everything is counted from recorded work, over the chosen days. */
  async programReport(days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scopes = await this.prisma.scope.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        circles: {
          where: { archivedAt: null },
          select: { id: true, memberships: { where: { leftAt: null }, select: { studentId: true } } },
        },
      },
    });
    const [attendance, gates, exams] = await Promise.all([
      this.prisma.evaluation.groupBy({ by: ['circleId', 'attendance'], where: { createdAt: { gte: since }, attendance: { not: null } }, _count: true }),
      this.prisma.surahGate.groupBy({ by: ['status'], where: { OR: [{ decidedAt: { gte: since } }, { status: 'PENDING' }] }, _count: true }),
      this.prisma.stageExam.groupBy({ by: ['passed'], where: { createdAt: { gte: since } }, _count: true }),
    ]);
    const memberIds = scopes.flatMap((scope) => scope.circles.flatMap((circle) => circle.memberships.map(({ studentId }) => studentId)));
    const summaries = await this.plans.summaries(memberIds);

    const passed = exams.find((row) => row.passed)?._count ?? 0;
    const failed = exams.find((row) => !row.passed)?._count ?? 0;

    return {
      days,
      gates: {
        passed: gates.find((row) => row.status === 'PASSED')?._count ?? 0,
        skipped: gates.find((row) => row.status === 'SKIPPED')?._count ?? 0,
        pending: gates.find((row) => row.status === 'PENDING')?._count ?? 0,
      },
      stageExams: { tested: passed + failed, passed, passRate: passed + failed === 0 ? null : Math.round((passed / (passed + failed)) * 100) },
      scopes: scopes.map((scope) => {
        const circleIds = new Set(scope.circles.map(({ id }) => id));
        const counts: Partial<Record<AttendanceStatus, number>> = {};
        for (const row of attendance) {
          if (row.circleId && circleIds.has(row.circleId) && row.attendance) {
            counts[row.attendance] = (counts[row.attendance] ?? 0) + row._count;
          }
        }
        const students = scope.circles.flatMap((circle) => circle.memberships.map(({ studentId }) => studentId));
        const values = students.flatMap((id) => {
          const commitment = summaries.get(id)?.commitment;
          return commitment === null || commitment === undefined ? [] : [commitment];
        });
        return {
          id: scope.id,
          name: scope.name,
          circles: scope.circles.length,
          students: students.length,
          attendanceRate: attendanceRate(counts),
          commitment: values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
          behind: students.filter((id) => summaries.get(id)?.status === 'late').length,
        };
      }),
    };
  }
}
