import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
};

const extensionOf = (mimeType: string) => EXTENSIONS[mimeType] ?? 'bin';

/**
 * Where each kind of file lives under the uploads folder, one folder per kind:
 *
 *   uploads/
 *     badges/<badgeId>.png
 *     certificates/backgrounds/<templateId>.<png|jpg|webp>
 *     certificates/assets/<assetId>.png
 *     recordings/<studentId>/<recordingId>.<m4a|webm>
 */
export const filePaths = {
  badgeImage: (badgeId: string) => `badges/${badgeId}.png`,
  certificateBackground: (templateId: string, mimeType: string) => `certificates/backgrounds/${templateId}.${extensionOf(mimeType)}`,
  certificateAsset: (assetId: string) => `certificates/assets/${assetId}.png`,
  recording: (studentId: string, recordingId: string, mimeType: string) => `recordings/${studentId}/${recordingId}.${extensionOf(mimeType)}`,
};

/** Files kept on the server's disk, in the uploads folder. The database keeps only what describes them. */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('UPLOADS_DIR') ?? 'uploads');
  }

  /** Written to a temporary name first, so a reader never sees half a file. */
  async write(path: string, data: Uint8Array): Promise<void> {
    const target = this.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target);
  }

  /** Null when there is no such file. */
  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async copy(from: string, to: string): Promise<boolean> {
    const target = this.resolve(to);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(this.resolve(from), target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Removing what isn't there is not an error. */
  async remove(path: string): Promise<void> {
    await rm(this.resolve(path), { force: true });
  }

  /** Every path stays inside the uploads folder, whatever ids it is built from. */
  private resolve(path: string): string {
    const full = resolve(this.root, path);
    if (!full.startsWith(this.root + sep)) throw new Error(`Path outside the uploads folder: ${path}`);
    return full;
  }
}
