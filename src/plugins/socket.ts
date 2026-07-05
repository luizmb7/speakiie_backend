import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server as SocketIOServer } from 'socket.io';
import { socketAuthMiddleware } from '../socket/middleware';
import { registerSocketHandlers } from '../socket/handlers';

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer;
  }
}

async function socketPlugin(fastify: FastifyInstance) {
  const io = new SocketIOServer(fastify.server, {
    cors: {
      origin: '*', // Em produção, restringir ao domínio do cliente
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // Middleware de autenticação
  io.use(socketAuthMiddleware);

  // Registrar event handlers
  io.on('connection', (socket) => {
    fastify.log.info({ userId: (socket.data as any).userId }, 'Socket conectado');
    registerSocketHandlers(io, socket, fastify.prisma);
  });

  fastify.decorate('io', io);

  fastify.addHook('onClose', async () => {
    io.close();
    fastify.log.info('Socket.IO encerrado');
  });

  fastify.log.info('✅ Socket.IO inicializado');
}

export default fp(socketPlugin, {
  name: 'socket',
  dependencies: ['prisma', 'auth'],
});
