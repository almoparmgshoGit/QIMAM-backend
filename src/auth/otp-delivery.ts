import { Injectable, Logger } from '@nestjs/common';

/** How a code reaches the student. The channel isn't chosen yet: a new one only needs to implement this. */
export abstract class OtpDelivery {
  abstract deliver(phone: string, code: string): Promise<void>;
}

/**
 * Development stand-in: prints the code to the backend's console.
 * validateEnv refuses it in production, where anyone reading the logs could sign in as anyone.
 */
@Injectable()
export class ConsoleOtpDelivery extends OtpDelivery {
  private readonly logger = new Logger('OTP');

  deliver(phone: string, code: string): Promise<void> {
    this.logger.log(`${phone} code: ${code}`);
    return Promise.resolve();
  }
}
