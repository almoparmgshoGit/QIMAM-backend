import { z } from 'zod';

const commaList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    /** Isolates the end-to-end tests from real data. */
    DATABASE_SCHEMA: z.string().regex(/^[a-z0-9_]+$/).optional(),
    JWT_PRIVATE_KEY_BASE64: z.string().min(100),
    JWT_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/),
    OTP_PEPPER: z.string().min(32),
    OTP_DELIVERY: z.enum(['console', 'authentica']),
    /** Required for authentica delivery. From the application's page in the Authentica portal. */
    AUTHENTICA_API_KEY: z.string().min(10).optional(),
    AUTHENTICA_METHOD: z.enum(['sms', 'whatsapp']).default('sms'),
    /** The message template in the Authentica portal. Authentica uses template 1 when unset. */
    AUTHENTICA_TEMPLATE_ID: z.coerce.number().int().positive().optional(),
    /**
     * App Review sign-in. One number, in international form such as +966500000000, that signs in with a fixed
     * code and no SMS. Set both or neither; leave them unset unless a review is running.
     */
    REVIEW_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
    REVIEW_CODE: z.string().regex(/^\d{4}$/).optional(),
    MAIL_DELIVERY: z.enum(['console', 'smtp']).default('console'),
    /** Such as smtps://user:pass@mail.example.com. Required for smtp delivery. */
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    /** Comma-separated. The dashboard origins allowed to call the API from a browser. */
    ADMIN_ORIGINS: z
      .string()
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(z.url()).min(1)),
    /** Base64 of 32 random bytes. Encrypts staff authenticator secrets. */
    TOTP_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'must be 32 bytes in base64'),
    /** Where uploaded files are kept: badge pictures, certificate backgrounds and recordings, each in its own folder. */
    UPLOADS_DIR: z.string().min(1).default('uploads'),
    /** Address or range of the reverse proxy, or "false" when there is none. */
    TRUST_PROXY: z.string().default('false'),
    /** Comma-separated. Helps two devices find a direct path for a voice call. */
    STUN_URLS: z
      .string()
      .default('stun:stun.l.google.com:19302')
      .transform(commaList),
    /** Comma-separated. Relays a voice call on networks that block a direct path. */
    TURN_URLS: z.string().transform(commaList).optional(),
    /** The server's static-auth-secret, from which short-lived call credentials are made. */
    TURN_SECRET: z.string().min(16).optional(),
    /**
     * iPhone notifications straight to Apple, without Expo: the team's APNs key (.p8) from developer.apple.com.
     * Set all three or none. The key's PEM text in base64.
     */
    APNS_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
    APNS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
    APNS_PRIVATE_KEY_BASE64: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').toString('utf8').includes('BEGIN PRIVATE KEY'), 'must be the .p8 file in base64')
      .optional(),
    /** The app's bundle id. */
    APNS_TOPIC: z.string().default('com.qimam.quran'),
    /** Needed only when "enhanced push security" is turned on for the project in Expo. */
    EXPO_ACCESS_TOKEN: z.string().min(10).optional(),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.TURN_URLS?.length) !== Boolean(env.TURN_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['TURN_SECRET'], message: 'TURN_URLS and TURN_SECRET go together' });
    }
    if (Boolean(env.REVIEW_PHONE) !== Boolean(env.REVIEW_CODE)) {
      ctx.addIssue({ code: 'custom', path: ['REVIEW_CODE'], message: 'REVIEW_PHONE and REVIEW_CODE go together' });
    }
    if (new Set([Boolean(env.APNS_KEY_ID), Boolean(env.APNS_TEAM_ID), Boolean(env.APNS_PRIVATE_KEY_BASE64)]).size > 1) {
      ctx.addIssue({ code: 'custom', path: ['APNS_KEY_ID'], message: 'APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY_BASE64 go together' });
    }
    if (env.MAIL_DELIVERY === 'smtp' && (!env.SMTP_URL || !env.MAIL_FROM)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'smtp delivery needs SMTP_URL and MAIL_FROM' });
    }
    if (env.OTP_DELIVERY === 'authentica' && !env.AUTHENTICA_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['AUTHENTICA_API_KEY'], message: 'authentica delivery needs AUTHENTICA_API_KEY' });
    }
    // A recovery link in the log would let anyone reading it take over an account.
    if (env.NODE_ENV === 'production' && env.MAIL_DELIVERY === 'console') {
      ctx.addIssue({ code: 'custom', path: ['MAIL_DELIVERY'], message: 'console is not allowed in production' });
    }
    // Console delivery prints codes to the log, so it must never reach production.
    if (env.NODE_ENV === 'production' && env.OTP_DELIVERY === 'console') {
      ctx.addIssue({ code: 'custom', path: ['OTP_DELIVERY'], message: 'console is not allowed in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Stops the server from starting on missing or invalid settings. Reports names only, never values. */
export function validateEnv(source: Record<string, unknown>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }
  return result.data;
}
