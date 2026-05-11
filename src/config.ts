import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  DEEPGRAM_API_KEY: z.string().min(1),

  OPENCLAW_URL: z.string().url(),

  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_REDIRECT_URI: z.string().url(),

  JWT_SECRET: z.string().min(32),
  INTERNAL_SECRET: z.string().min(1),

  FRONTEND_ORIGIN: z.string().url(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Missing or invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
