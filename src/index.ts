import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env';
import { AppError } from './utils/errors';
import { ZodError } from 'zod';
import { FastifyError } from 'fastify';

// Plugins
import prismaPlugin from './plugins/prisma';
import authPlugin from './plugins/auth';
import socketPlugin from './plugins/socket';

// Routes
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import serverRoutes from './routes/servers';
import channelRoutes from './routes/channels';
import messageRoutes from './routes/messages';
import memberRoutes from './routes/members';
import roleRoutes from './routes/roles';
import voiceRoutes from './routes/voice';
import webhookRoutes from './routes/webhooks';

// Jobs
import { startGuestCleanupJob } from './jobs/cleanup-guests';

async function main() {
  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // ── Plugins globais ──
  await fastify.register(cors, {
    origin: env.NODE_ENV === 'production'
      ? [/\.seudominio\.com$/] // Em produção, restringir ao domínio
      : true, // Em dev, aceita qualquer origem
    credentials: true,
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    // Rate limit mais agressivo para rotas de auth
    keyGenerator: (request) => {
      return request.ip;
    },
  });

  // ── Plugins da aplicação ──
  await fastify.register(prismaPlugin);
  await fastify.register(authPlugin);
  await fastify.register(socketPlugin);

  // ── Error handler global ──
  fastify.setErrorHandler((error: FastifyError | Error, request, reply) => {
    // Erros de validação do Zod
    if (error instanceof ZodError) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        errors: error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    // Erros da aplicação (AppError)
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
      });
    }

    // Erros do Fastify (rate limit, etc.)
    const fastifyErr = error as FastifyError;
    if (fastifyErr.statusCode) {
      return reply.status(fastifyErr.statusCode).send({
        statusCode: fastifyErr.statusCode,
        code: fastifyErr.code || 'ERROR',
        message: fastifyErr.message,
      });
    }

    // Erros inesperados
    fastify.log.error(error);
    return reply.status(500).send({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production'
        ? 'Erro interno do servidor'
        : error.message,
    });
  });

  // ── Registrar rotas ──
  await fastify.register(healthRoutes);
  await fastify.register(authRoutes, { prefix: '/auth' });
  await fastify.register(serverRoutes);
  await fastify.register(channelRoutes);
  await fastify.register(messageRoutes);
  await fastify.register(memberRoutes);
  await fastify.register(roleRoutes);
  await fastify.register(voiceRoutes);
  await fastify.register(webhookRoutes, { prefix: '/webhooks' });

  // ── Iniciar jobs periódicos ──
  startGuestCleanupJob(fastify.prisma);

  // ── Iniciar servidor ──
  try {
    const address = await fastify.listen({ port: env.PORT, host: env.HOST });
    fastify.log.info(`🚀 Speakiie backend rodando em ${address}`);
  } catch (err) {
    fastify.log.fatal(err);
    process.exit(1);
  }

  // ── Graceful shutdown ──
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      fastify.log.info(`Recebido ${signal}, encerrando...`);
      await fastify.close();
      process.exit(0);
    });
  }
}

main();
