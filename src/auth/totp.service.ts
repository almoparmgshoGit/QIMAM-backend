import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify } from 'otplib';

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TOLERANCE_SECONDS = 30;

@Injectable()
export class TotpService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('TOTP_ENCRYPTION_KEY'), 'base64');
  }

  createEnrollment(label: string): { secret: string; otpauthUri: string; encrypted: string } {
    const secret = generateSecret();
    return {
      secret,
      otpauthUri: generateURI({ issuer: 'Qimam', label, secret }),
      encrypted: this.encrypt(secret),
    };
  }

  /** Returns the code's time step when it is right and newer than the last accepted one, or null. */
  async check(encrypted: string, code: string, lastStep: number | null): Promise<number | null> {
    try {
      const result = await verify({
        secret: this.decrypt(encrypted),
        token: code,
        epochTolerance: TOLERANCE_SECONDS,
        ...(lastStep === null ? {} : { afterTimeStep: lastStep }),
      });
      // TOTP results carry the time step. The shared result type also covers HOTP, which has none.
      const { timeStep } = result as { timeStep?: number };
      return result.valid && timeStep !== undefined ? timeStep : null;
    } catch {
      return null;
    }
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
  }

  private decrypt(stored: string): string {
    const [iv, tag, body] = stored.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv(CIPHER, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}
