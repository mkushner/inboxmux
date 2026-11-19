import { z } from 'zod';

const list = (s: string) =>
  s
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

const schema = z.object({
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_PATH: z.string().default('./data/inboxmux.db'),
  INBOXMUX_ENCRYPTION_KEY: z.string().min(1),
  OWNER_EMAILS: z.string().transform(list).pipe(z.array(z.email()).min(1)),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),
  ALLOWED_REDIRECT_ORIGINS: z
    .string()
    .default('')
    .transform(list)
    .pipe(z.array(z.url().transform((u) => new URL(u).origin))),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${fields}`);
  }
  return parsed.data;
}
