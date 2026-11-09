import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

export interface StaffMail {
  to: string;
  subject: string;
  text: string;
}

/** How a message reaches a staff member's inbox. */
export abstract class StaffMailer {
  abstract send(mail: StaffMail): Promise<void>;
}

/**
 * Development stand-in: prints the message to the backend's console.
 * validateEnv refuses it in production, where anyone reading the logs could take over an account.
 */
@Injectable()
export class ConsoleStaffMailer extends StaffMailer {
  private readonly logger = new Logger('Mail');

  send({ to, subject, text }: StaffMail): Promise<void> {
    this.logger.log(`${to} | ${subject}\n${text}`);
    return Promise.resolve();
  }
}

@Injectable()
export class SmtpStaffMailer extends StaffMailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    super();
    this.transport = nodemailer.createTransport(config.getOrThrow<string>('SMTP_URL'));
    this.from = config.getOrThrow<string>('MAIL_FROM');
  }

  async send(mail: StaffMail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}
