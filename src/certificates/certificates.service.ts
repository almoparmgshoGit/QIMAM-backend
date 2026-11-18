import { Injectable } from '@nestjs/common';
import type { StaffActor } from '../auth/staff.decorators.js';
import { ApiError } from '../common/api-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../prisma/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../program/notifications.service.js';
import { filePaths, StorageService } from '../storage/storage.service.js';
import {
  type CertificateElement,
  certificateElementsSchema,
  type CreateAssetDto,
  type CreateTemplateDto,
  type HonorDto,
  type IssueDto,
  type UpdateTemplateDto,
} from './certificates.schemas.js';

const notFound = () => new ApiError(404, 'not_found');

export const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_SIDE = 4000;

const ZONE = 'Asia/Riyadh';
const GREGORIAN = new Intl.DateTimeFormat('ar-u-nu-latn', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: ZONE,
});
const HIJRI = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: ZONE,
});

type VariableKey =
  | 'name'
  | 'track'
  | 'date'
  | 'hijri'
  | 'number'
  | 'circle'
  | 'teacher'
  | 'country'
  | 'note'
  | 'certificate';

/** What a design can print. The dashboard lists these with their samples, so the board shows a real-looking page. */
export const CERTIFICATE_VARIABLES: {
  key: VariableKey;
  label: string;
  sample: string;
}[] = [
  { key: 'name', label: 'اسم الطالب', sample: 'فاطمة عبدالله' },
  { key: 'track', label: 'المسار', sample: 'مسار الحفظ المتقن' },
  {
    key: 'date',
    label: 'تاريخ الإصدار',
    sample: GREGORIAN.format(new Date('2026-05-14T12:00:00Z')),
  },
  {
    key: 'hijri',
    label: 'التاريخ الهجري',
    sample: HIJRI.format(new Date('2026-05-14T12:00:00Z')),
  },
  { key: 'number', label: 'رقم الشهادة', sample: '00042' },
  { key: 'circle', label: 'الحلقة', sample: 'حلقة النور' },
  { key: 'teacher', label: 'المعلم', sample: 'أ. مريم صالح' },
  { key: 'country', label: 'الدولة', sample: 'السعودية' },
  { key: 'note', label: 'سبب المنح', sample: 'تقديرًا لتميّزها في الحفظ' },
  { key: 'certificate', label: 'اسم الشهادة', sample: 'شهادة إتمام مسار' },
];

const VARIABLE = /\{\{([^{}]{1,120})\}\}/g;

/** Fills a text's variables. {{a|b}} picks a for the men's section and b for the women's. */
export function fillText(
  text: string,
  values: Record<VariableKey, string>,
  section: 'MEN' | 'WOMEN',
): string {
  return text.replace(VARIABLE, (_match, inner: string) => {
    if (inner.includes('|')) {
      const [men = '', women = ''] = inner.split('|');
      return (section === 'MEN' ? men : women).trim();
    }
    return values[inner.trim() as VariableKey] ?? '';
  });
}

/** Checks the file's own bytes, since its name and declared type are whatever the browser sent. */
function imageType(data: Buffer): string | null {
  if (
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG's size, and whether it can be see-through: an alpha channel, or a palette or colour marked transparent.
 * An attachment is printed over the page, so one without a clear background would hide what is under it.
 */
function pngInfo(data: Buffer): { width: number; height: number; transparent: boolean } | null {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (data.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const colorType = data[25];
  let transparent = colorType === 4 || colorType === 6;
  // A tRNS chunk gives transparency to palette and plain colour pictures. It comes before the image data.
  for (let at = 8; !transparent && at + 8 <= data.length; ) {
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'tRNS') transparent = true;
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + length;
  }
  return { width, height, transparent };
}

/** A background's row: its type, and its bytes only when it was saved before files moved to the uploads folder. */
type BackgroundRow = { mimeType: string; data: Uint8Array | null } | null;

const serialText = (serial: number) => String(serial).padStart(5, '0');

/** The month a circle honoring belongs to, as YYYY-MM. Matches the motivation page's month. */
const currentMonth = () => new Date().toISOString().slice(0, 7);

/** Rows written before a shape changed are dropped rather than failing the whole page. */
const readElements = (value: Prisma.JsonValue): CertificateElement[] => {
  const parsed = certificateElementsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  /** The background as a data URL, read from the uploads folder, or from the database for an older one. */
  private async backgroundUrl(templateId: string, background: BackgroundRow): Promise<string | null> {
    if (!background) return null;
    const data = (await this.storage.read(filePaths.certificateBackground(templateId, background.mimeType))) ?? background.data;
    return data ? `data:${background.mimeType};base64,${Buffer.from(data).toString('base64')}` : null;
  }

  /**
   * Gives each attachment element its picture as a data URL, so every page draws it with no request of its own.
   * An attachment deleted from the library gets null and is left off the page.
   */
  private async withImages(elements: CertificateElement[]) {
    const ids = [...new Set(elements.flatMap((element) => (element.type === 'image' ? [element.assetId] : [])))];
    if (ids.length === 0) return elements;
    const found = await this.prisma.certificateAsset.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const sources = new Map<string, string>();
    await Promise.all(
      found.map(async ({ id }) => {
        const data = await this.storage.read(filePaths.certificateAsset(id));
        if (data) sources.set(id, `data:image/png;base64,${data.toString('base64')}`);
      }),
    );
    return elements.map((element) =>
      element.type === 'image' ? { ...element, src: sources.get(element.assetId) ?? null } : element,
    );
  }

  // ---------- Attachments ----------

  async listAssets() {
    const assets = await this.prisma.certificateAsset.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, kind: true, width: true, height: true, createdAt: true },
    });
    return Promise.all(
      assets.map(async (asset) => {
        const data = await this.storage.read(filePaths.certificateAsset(asset.id));
        return { ...asset, src: data ? `data:image/png;base64,${data.toString('base64')}` : null };
      }),
    );
  }

  async createAsset(admin: StaffActor, dto: CreateAssetDto, file: { buffer: Buffer } | undefined) {
    if (!file || file.buffer.length === 0) throw new ApiError(400, 'file_required');
    if (file.buffer.length > MAX_ASSET_BYTES) throw new ApiError(413, 'payload_too_large');
    const info = pngInfo(file.buffer);
    if (!info) throw new ApiError(400, 'unsupported_file_type');
    if (!info.transparent) throw new ApiError(400, 'asset_background_required');
    if (info.width < 1 || info.height < 1 || info.width > MAX_ASSET_SIDE || info.height > MAX_ASSET_SIDE)
      throw new ApiError(400, 'unsupported_file_type');
    const { id } = await this.prisma.certificateAsset.create({
      data: { ...dto, width: info.width, height: info.height },
      select: { id: true },
    });
    try {
      await this.storage.write(filePaths.certificateAsset(id), file.buffer);
    } catch (failure) {
      await this.prisma.certificateAsset.delete({ where: { id } });
      throw failure;
    }
    await this.audit.record(admin, 'certificate_asset.create', { type: 'certificate_asset', id }, { kind: dto.kind });
    return { id };
  }

  /** Refused while a design still places it, so no certificate loses a signature it was given with. */
  async deleteAsset(admin: StaffActor, id: string): Promise<void> {
    const asset = await this.prisma.certificateAsset.findUnique({ where: { id }, select: { id: true } });
    if (!asset) throw notFound();
    const templates = await this.prisma.certificateTemplate.findMany({ select: { name: true, elements: true } });
    const usedBy = templates
      .filter(({ elements }) => readElements(elements).some((element) => element.type === 'image' && element.assetId === id))
      .map(({ name }) => name);
    if (usedBy.length > 0) throw new ApiError(409, 'certificate_asset_in_use', { templates: usedBy });
    await this.prisma.certificateAsset.delete({ where: { id } });
    await this.storage.remove(filePaths.certificateAsset(id));
    await this.audit.record(admin, 'certificate_asset.delete', { type: 'certificate_asset', id });
  }

  // ---------- Issuing ----------

  /**
   * Gives finished students the track certificates they are owed. Run when certificates are read, so a design
   * added later also reaches students who finished before it.
   */
  async issueTrackCertificates(studentId?: string): Promise<void> {
    const templates = await this.prisma.certificateTemplate.findMany({
      where: { trigger: 'TRACK_COMPLETED', active: true },
      select: { id: true, trackTemplateId: true },
    });
    if (templates.length === 0) return;
    const plans = await this.prisma.studentPlan.findMany({
      where: { status: 'COMPLETED', ...(studentId ? { studentId } : {}) },
      select: {
        studentId: true,
        templateId: true,
        completedAt: true,
        updatedAt: true,
      },
    });
    const data = plans.flatMap((plan) =>
      templates
        .filter(
          ({ trackTemplateId }) =>
            trackTemplateId === null || trackTemplateId === plan.templateId,
        )
        .map(({ id }) => ({
          templateId: id,
          studentId: plan.studentId,
          issuedAt: plan.completedAt ?? plan.updatedAt,
        })),
    );
    if (data.length > 0)
      await this.prisma.issuedCertificate.createMany({
        data,
        skipDuplicates: true,
      });
  }

  async issue(
    admin: StaffActor,
    templateId: string,
    { studentIds, note }: IssueDto,
  ) {
    const template = await this.prisma.certificateTemplate.findUnique({
      where: { id: templateId },
      select: { name: true },
    });
    if (!template) throw notFound();
    const students = await this.prisma.user.findMany({
      where: { id: { in: studentIds }, role: 'STUDENT' },
      select: { id: true },
    });
    if (students.length === 0) throw notFound();
    const created = await this.prisma.issuedCertificate.createManyAndReturn({
      data: students.map(({ id }) => ({
        templateId,
        studentId: id,
        issuedById: admin.id,
        note: note || null,
      })),
      skipDuplicates: true,
      select: { studentId: true },
    });
    const reached = created.map(({ studentId }) => studentId);
    await this.notifications.send(reached, {
      type: 'BADGES',
      title: 'شهادة جديدة',
      body: `حصلت على «${template.name}». تجدها في صفحة شهاداتك.`,
      dedupeKey: `certificate:${templateId}`,
    });
    await this.audit.record(
      admin,
      'certificate.issue',
      { type: 'certificate_template', id: templateId },
      { students: reached.length },
    );
    return {
      issued: reached.length,
      alreadyHeld: students.length - reached.length,
    };
  }

  async revoke(admin: StaffActor, issuedId: string): Promise<void> {
    const issued = await this.prisma.issuedCertificate.findUnique({
      where: { id: issuedId },
      select: { templateId: true, studentId: true },
    });
    if (!issued) throw notFound();
    await this.prisma.issuedCertificate.delete({ where: { id: issuedId } });
    await this.audit.record(
      admin,
      'certificate.revoke',
      { type: 'student', id: issued.studentId },
      { templateId: issued.templateId },
    );
  }

  // ---------- Templates ----------

  async listTemplates() {
    await this.issueTrackCertificates();
    const [templates, tracks] = await Promise.all([
      this.prisma.certificateTemplate.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          trigger: true,
          trackTemplateId: true,
          active: true,
          width: true,
          height: true,
          updatedAt: true,
          trackTemplate: { select: { name: true } },
          background: { select: { updatedAt: true } },
          _count: { select: { issued: true } },
        },
      }),
      this.prisma.trackTemplate.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      }),
    ]);
    return {
      templates: templates.map(
        ({
          trackTemplateId,
          trackTemplate,
          background,
          _count,
          ...template
        }) => ({
          ...template,
          trackId: trackTemplateId,
          trackName: trackTemplate?.name ?? null,
          hasBackground: background !== null,
          issued: _count.issued,
        }),
      ),
      tracks,
      variables: CERTIFICATE_VARIABLES,
    };
  }

  async getTemplate(id: string) {
    const template = await this.prisma.certificateTemplate.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        trigger: true,
        trackTemplateId: true,
        active: true,
        width: true,
        height: true,
        elements: true,
        updatedAt: true,
        background: { select: { mimeType: true, data: true } },
      },
    });
    if (!template) throw notFound();
    const { trackTemplateId, background, elements, ...rest } = template;
    return {
      ...rest,
      trackId: trackTemplateId,
      elements: await this.withImages(readElements(elements)),
      background: await this.backgroundUrl(id, background),
    };
  }

  async createTemplate(
    admin: StaffActor,
    { trackId, ...dto }: CreateTemplateDto,
  ) {
    await this.checkTrack(trackId);
    const { id } = await this.prisma.certificateTemplate.create({
      data: {
        ...dto,
        trackTemplateId: dto.trigger === 'TRACK_COMPLETED' ? trackId : null,
      },
      select: { id: true },
    });
    await this.audit.record(admin, 'certificate_template.create', {
      type: 'certificate_template',
      id,
    });
    return { id };
  }

  async updateTemplate(
    admin: StaffActor,
    id: string,
    { trackId, ...dto }: UpdateTemplateDto,
  ): Promise<void> {
    const current = await this.prisma.certificateTemplate.findUnique({
      where: { id },
      select: { trigger: true },
    });
    if (!current) throw notFound();
    if (trackId !== undefined) await this.checkTrack(trackId);
    const trigger = dto.trigger ?? current.trigger;
    // Only a track certificate is tied to a track.
    const trackTemplateId = trigger === 'TRACK_COMPLETED' ? trackId : null;
    await this.prisma.certificateTemplate.update({
      where: { id },
      data: { ...dto, trackTemplateId },
    });
    await this.audit.record(admin, 'certificate_template.update', {
      type: 'certificate_template',
      id,
    });
  }

  async duplicateTemplate(admin: StaffActor, id: string) {
    const source = await this.prisma.certificateTemplate.findUnique({
      where: { id },
      select: {
        name: true,
        trigger: true,
        trackTemplateId: true,
        width: true,
        height: true,
        elements: true,
        background: { select: { mimeType: true, data: true } },
      },
    });
    if (!source) throw notFound();
    const { background, elements, name, ...rest } = source;
    const { id: copyId } = await this.prisma.certificateTemplate.create({
      data: {
        ...rest,
        name: `${name} (نسخة)`.slice(0, 120),
        // A copy starts paused, so it is never issued before it is checked.
        active: false,
        elements: readElements(elements),
      },
      select: { id: true },
    });
    if (background) {
      const to = filePaths.certificateBackground(copyId, background.mimeType);
      const copied = await this.storage.copy(filePaths.certificateBackground(id, background.mimeType), to);
      // A background saved before the move is still in the database: the copy is written out from there.
      if (!copied && background.data) await this.storage.write(to, background.data);
      if (copied || background.data) {
        await this.prisma.certificateBackground.create({ data: { templateId: copyId, mimeType: background.mimeType, data: null } });
      }
    }
    await this.audit.record(
      admin,
      'certificate_template.create',
      { type: 'certificate_template', id: copyId },
      { copyOf: id },
    );
    return { id: copyId };
  }

  /** Also takes back every certificate issued from it. The dashboard asks before calling this. */
  async deleteTemplate(admin: StaffActor, id: string): Promise<void> {
    const background = await this.prisma.certificateBackground.findUnique({ where: { templateId: id }, select: { mimeType: true } });
    const { count } = await this.prisma.certificateTemplate.deleteMany({
      where: { id },
    });
    if (count !== 1) throw notFound();
    if (background) await this.storage.remove(filePaths.certificateBackground(id, background.mimeType));
    await this.audit.record(admin, 'certificate_template.delete', {
      type: 'certificate_template',
      id,
    });
  }

  async setBackground(
    admin: StaffActor,
    id: string,
    file: { buffer: Buffer } | undefined,
  ) {
    if (!file || file.buffer.length === 0)
      throw new ApiError(400, 'file_required');
    if (file.buffer.length > MAX_BACKGROUND_BYTES)
      throw new ApiError(413, 'payload_too_large');
    const mimeType = imageType(file.buffer);
    if (!mimeType) throw new ApiError(400, 'unsupported_file_type');
    const template = await this.prisma.certificateTemplate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!template) throw notFound();
    const data = file.buffer;
    const previous = await this.prisma.certificateBackground.findUnique({ where: { templateId: id }, select: { mimeType: true } });
    await this.storage.write(filePaths.certificateBackground(id, mimeType), data);
    // A picture of another type had another file name.
    if (previous && previous.mimeType !== mimeType) await this.storage.remove(filePaths.certificateBackground(id, previous.mimeType));
    await this.prisma.certificateBackground.upsert({
      where: { templateId: id },
      create: { templateId: id, mimeType, data: null },
      update: { mimeType, data: null },
    });
    // The template's own date changes too, so lists show it was edited.
    await this.prisma.certificateTemplate.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
    await this.audit.record(
      admin,
      'certificate_template.background',
      { type: 'certificate_template', id },
      { bytes: data.length },
    );
  }

  async removeBackground(admin: StaffActor, id: string): Promise<void> {
    const background = await this.prisma.certificateBackground.findUnique({ where: { templateId: id }, select: { mimeType: true } });
    await this.prisma.certificateBackground.deleteMany({
      where: { templateId: id },
    });
    if (background) await this.storage.remove(filePaths.certificateBackground(id, background.mimeType));
    await this.audit.record(
      admin,
      'certificate_template.background',
      { type: 'certificate_template', id },
      { bytes: 0 },
    );
  }

  async listIssued(templateId: string) {
    const template = await this.prisma.certificateTemplate.findUnique({
      where: { id: templateId },
      select: { id: true },
    });
    if (!template) throw notFound();
    const rows = await this.prisma.issuedCertificate.findMany({
      where: { templateId },
      orderBy: { issuedAt: 'desc' },
      take: 500,
      select: {
        id: true,
        serial: true,
        note: true,
        issuedAt: true,
        issuedById: true,
        student: { select: { id: true, fullName: true } },
        circle: { select: { name: true } },
      },
    });
    return rows.map(({ serial, student, issuedById, circle, ...row }) => ({
      ...row,
      number: serialText(serial),
      studentId: student.id,
      studentName: student.fullName,
      automatic: issuedById === null,
      /** Set when it was given with a circle honoring. */
      circleName: circle?.name ?? null,
    }));
  }

  private async checkTrack(trackId: string | null | undefined) {
    if (!trackId) return;
    const track = await this.prisma.trackTemplate.findUnique({
      where: { id: trackId },
      select: { id: true },
    });
    if (!track) throw new ApiError(400, 'unknown_track');
  }

  // ---------- Circle honoring ----------

  /** What the honoring dialog shows: the designs to choose from, and the circle's own values to preview them with. */
  async honorOptions(circleId: string) {
    const circle = await this.circleToHonor(circleId);
    const templates = await this.prisma.certificateTemplate.findMany({
      where: {
        trigger: { in: ['CIRCLE_HONOR', 'CIRCLE_HONOR_TEACHER'] },
        active: true,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        trigger: true,
        width: true,
        height: true,
        elements: true,
        background: { select: { mimeType: true, data: true } },
      },
    });
    const pages = (trigger: 'CIRCLE_HONOR' | 'CIRCLE_HONOR_TEACHER') =>
      Promise.all(
        templates
          .filter((template) => template.trigger === trigger)
          .map(async ({ id, name, width, height, elements, background }) => ({
            id,
            name,
            width,
            height,
            elements: await this.withImages(readElements(elements)),
            background: await this.backgroundUrl(id, background),
          })),
      );
    const now = new Date();
    // The number is given when the certificate is, and the note is typed in the dialog.
    const shared = {
      track: circle.trackTemplate?.name ?? '',
      date: GREGORIAN.format(now),
      hijri: HIJRI.format(now),
      number: '—',
      circle: circle.name,
      teacher: circle.teacher?.fullName ?? '',
      note: '',
    };
    const first = circle.memberships[0]?.student;
    return {
      circle: {
        id: circle.id,
        name: circle.name,
        teacher: circle.teacher?.fullName ?? null,
        students: circle.memberships.length,
        honored: circle.honoredMonth === currentMonth(),
      },
      students: {
        templates: await pages('CIRCLE_HONOR'),
        section: first?.section ?? 'WOMEN',
        values: {
          ...shared,
          name: first?.fullName ?? 'اسم الطالبة',
          country: first?.country ?? '',
        },
      },
      teacher: circle.teacher
        ? {
            templates: await pages('CIRCLE_HONOR_TEACHER'),
            section: circle.teacher.section,
            values: {
              ...shared,
              name: circle.teacher.fullName,
              country: circle.teacher.country ?? '',
            },
          }
        : null,
    };
  }

  /**
   * A circle is honored once a month. Its students and its teacher hear about it, and each gets the circle
   * honoring certificate chosen for them.
   */
  async honorCircle(
    admin: StaffActor,
    circleId: string,
    { studentTemplateId, teacherTemplateId, note }: HonorDto,
  ) {
    const month = currentMonth();
    const circle = await this.circleToHonor(circleId);
    if (circle.honoredMonth === month)
      throw new ApiError(409, 'circle_already_honored');
    const teacher = circle.teacher;
    const [studentTemplate, teacherTemplate] = await Promise.all([
      this.honorTemplate('CIRCLE_HONOR', studentTemplateId),
      teacher
        ? this.honorTemplate('CIRCLE_HONOR_TEACHER', teacherTemplateId)
        : null,
    ]);

    const studentIds = circle.memberships.map(({ student }) => student.id);
    const occasion = `honor:${circleId}:${month}`;
    const given = (templateId: string, holderIds: string[]) =>
      holderIds.map((holderId) => ({
        templateId,
        studentId: holderId,
        issuedById: admin.id,
        note: note || null,
        circleId,
        occasion,
      }));

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.circle.updateMany({
        where: {
          id: circleId,
          OR: [{ honoredMonth: null }, { honoredMonth: { not: month } }],
        },
        data: { honoredMonth: month },
      });
      if (count !== 1) throw new ApiError(409, 'circle_already_honored');
      const data = [
        ...(studentTemplate ? given(studentTemplate.id, studentIds) : []),
        ...(teacherTemplate && teacher
          ? given(teacherTemplate.id, [teacher.id])
          : []),
      ];
      if (data.length > 0)
        await tx.issuedCertificate.createMany({ data, skipDuplicates: true });
    });

    await this.notifications.send(studentIds, {
      type: 'GENERAL',
      title: 'تكريم حلقتك',
      body: studentTemplate
        ? `كُرّمت ${circle.name} هذا الشهر، ووصلتك «${studentTemplate.name}». {{تجدها|تجدينها}} في صفحة شهاداتك.`
        : `كُرّمت ${circle.name} هذا الشهر. بارك الله {{فيكم|فيكن}}.`,
      dedupeKey: `honor:${circleId}:${month}`,
    });
    if (teacher)
      await this.notifications.send([teacher.id], {
        type: 'GENERAL',
        title: 'تكريم حلقتك',
        body: teacherTemplate
          ? `كُرّمت ${circle.name} هذا الشهر، ووصلتك «${teacherTemplate.name}». {{تجدها|تجدينها}} في «شهاداتي».`
          : `كُرّمت ${circle.name} هذا الشهر. بارك الله فيك.`,
        dedupeKey: `honor-certificate:${circleId}:${month}`,
      });
    const studentCertificates = studentTemplate ? studentIds.length : 0;
    await this.audit.record(
      admin,
      'circle.honor',
      { type: 'circle', id: circleId },
      {
        studentCertificate: studentTemplate?.id ?? null,
        teacherCertificate: teacherTemplate?.id ?? null,
        students: studentCertificates,
      },
    );
    return {
      studentCertificates,
      teacherCertificate: teacherTemplate !== null,
    };
  }

  private async circleToHonor(circleId: string) {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, archivedAt: null },
      select: {
        id: true,
        name: true,
        honoredMonth: true,
        trackTemplate: { select: { name: true } },
        teacher: {
          select: { id: true, fullName: true, section: true, country: true },
        },
        memberships: {
          where: {
            leftAt: null,
            student: { role: 'STUDENT', status: 'ACTIVE' },
          },
          orderBy: { joinedAt: 'asc' },
          select: {
            student: {
              select: {
                id: true,
                fullName: true,
                section: true,
                country: true,
              },
            },
          },
        },
      },
    });
    if (!circle) throw notFound();
    return circle;
  }

  /** The design chosen, or the only active one of its kind. Null when there is none, or none was wanted. */
  private async honorTemplate(
    trigger: 'CIRCLE_HONOR' | 'CIRCLE_HONOR_TEACHER',
    chosen: string | null | undefined,
  ) {
    if (chosen === null) return null;
    const templates = await this.prisma.certificateTemplate.findMany({
      where: { trigger, active: true, ...(chosen ? { id: chosen } : {}) },
      select: { id: true, name: true },
      take: 2,
    });
    if (chosen) {
      if (!templates[0]) throw new ApiError(400, 'unknown_certificate');
      return templates[0];
    }
    if (templates.length > 1)
      throw new ApiError(400, 'certificate_choice_required');
    return templates[0] ?? null;
  }

  // ---------- Holders ----------

  /** A teacher's own certificates, given with circle honorings. */
  staffCertificates(userId: string) {
    return this.heldCertificates(userId);
  }

  async studentCertificates(studentId: string) {
    await this.issueTrackCertificates(studentId);
    return this.heldCertificates(studentId);
  }

  private async heldCertificates(studentId: string) {
    const rows = await this.prisma.issuedCertificate.findMany({
      where: { studentId },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        serial: true,
        issuedAt: true,
        template: { select: { name: true, width: true, height: true } },
      },
    });
    return rows.map(({ id, serial, issuedAt, template }) => ({
      id,
      title: template.name,
      number: serialText(serial),
      issuedAt,
      width: template.width,
      height: template.height,
    }));
  }

  /**
   * A certificate ready to draw: its page, background and elements with every variable filled in.
   * With a student id, only that student's own certificate is found.
   */
  async render(issuedId: string, studentId?: string) {
    const issued = await this.prisma.issuedCertificate.findFirst({
      where: { id: issuedId, ...(studentId ? { studentId } : {}) },
      select: {
        id: true,
        templateId: true,
        serial: true,
        note: true,
        issuedAt: true,
        template: {
          select: {
            name: true,
            width: true,
            height: true,
            elements: true,
            background: { select: { mimeType: true, data: true } },
          },
        },
        circle: {
          select: {
            name: true,
            teacher: { select: { fullName: true } },
            trackTemplate: { select: { name: true } },
          },
        },
        student: {
          select: {
            fullName: true,
            section: true,
            country: true,
            trackTemplate: { select: { name: true } },
            plan: { select: { template: { select: { name: true } } } },
            memberships: {
              where: { leftAt: null },
              take: 1,
              select: {
                circle: {
                  select: {
                    name: true,
                    teacher: { select: { fullName: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!issued) throw notFound();

    const { template, student } = issued;
    // A circle honoring prints the circle honored, even after the holder moves.
    const circle = issued.circle ?? student.memberships[0]?.circle;
    const values: Record<VariableKey, string> = {
      name: student.fullName,
      track:
        student.plan?.template.name ??
        student.trackTemplate?.name ??
        issued.circle?.trackTemplate?.name ??
        '',
      date: GREGORIAN.format(issued.issuedAt),
      hijri: HIJRI.format(issued.issuedAt),
      number: serialText(issued.serial),
      circle: circle?.name ?? '',
      teacher: circle?.teacher?.fullName ?? '',
      country: student.country ?? '',
      note: issued.note ?? '',
      certificate: template.name,
    };

    return {
      id: issued.id,
      title: template.name,
      number: values.number,
      issuedAt: issued.issuedAt,
      width: template.width,
      height: template.height,
      background: await this.backgroundUrl(issued.templateId, template.background),
      elements: (await this.withImages(readElements(template.elements))).map((element) =>
        element.type === 'text'
          ? {
              ...element,
              text: fillText(element.text, values, student.section),
            }
          : element,
      ),
    };
  }
}
