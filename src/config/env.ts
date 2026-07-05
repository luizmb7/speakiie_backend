import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter pelo menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('90d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('180d'),

  // LiveKit
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_WS_URL: z.string().min(1),

  // Server
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Housekeeping
  GUEST_EXPIRY_DAYS: z.coerce.number().default(90),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Variáveis de ambiente inválidas:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
