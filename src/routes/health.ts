import { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (request, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    // Check PostgreSQL
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      checks.database = 'connected';
    } catch {
      checks.database = 'disconnected';
      healthy = false;
    }

    // Check Redis (se configurado)
    // TODO: Adicionar verificação de Redis quando implementar o adapter

    checks.redis = 'not_configured';

    // Check LiveKit (básico — verifica se a URL está definida)
    checks.livekit = process.env.LIVEKIT_WS_URL ? 'configured' : 'not_configured';

    const status = healthy ? 'healthy' : 'degraded';
    const statusCode = healthy ? 200 : 503;

    return reply.status(statusCode).send({
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks,
      version: '1.0.0',
    });
  });
}
