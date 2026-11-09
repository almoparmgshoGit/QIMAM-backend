import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import { ApiError } from '../common/api-error.js';

const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const PWNED_TIMEOUT_MS = 3000;

/** Checks a password against known breaches. Only the first 5 hash characters leave the server. */
@Injectable()
export class LeakedPasswordChecker {
  private readonly logger = new Logger(LeakedPasswordChecker.name);

  async isLeaked(password: string): Promise<boolean> {
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
    try {
      const response = await fetch(`${PWNED_RANGE_URL}${hash.slice(0, 5)}`, {
        headers: { 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(PWNED_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const suffix = hash.slice(5);
      return (await response.text()).split('\n').some((line) => {
        const [candidate, count] = line.trim().split(':');
        return candidate === suffix && Number(count) > 0;
      });
    } catch (error) {
      // An outage of this outside service must not stop staff from setting a password.
      this.logger.warn(`Breach check unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      return false;
    }
  }
}

@Injectable()
export class PasswordService {
  // Verified when no account matches, so a wrong email takes as long as a wrong password.
  private readonly dummyHash = argon2.hash('qimam-no-account-placeholder', { type: argon2.argon2id });

  constructor(private readonly leaked: LeakedPasswordChecker) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    return argon2.verify(hash ?? (await this.dummyHash), password);
  }

  /** The length limits are in the request schema. This covers what depends on the account or on outside data. */
  async assertAcceptable(password: string, personal: { email?: string | null; fullName: string }): Promise<void> {
    const lowered = password.toLowerCase();
    const parts = [personal.email?.split('@')[0], ...personal.fullName.split(/\s+/)];
    if (parts.some((part) => part && part.length >= 3 && lowered.includes(part.toLowerCase()))) {
      throw new ApiError(400, 'weak_password');
    }
    if (await this.leaked.isLeaked(password)) throw new ApiError(400, 'leaked_password');
  }
}
