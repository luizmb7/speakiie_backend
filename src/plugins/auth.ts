import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';

export interface JwtPayload {
  userId: string;
  isGuest: boolean;
  type: 'access' | 'refresh';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

async function authPlugin(fastify: FastifyInstance) {
  // Decorator para extrair o JWT do header Authorization
  fastify.decorateRequest('user', undefined);

  // Hook que roda ANTES das rotas marcadas com preHandler: [fastify.authenticate]
  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Token não fornecido');
    }

    const token = authHeader.substring(7);

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

      if (payload.type !== 'access') {
        throw new UnauthorizedError('Tipo de token inválido');
      }

      request.user = payload;
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      throw new UnauthorizedError('Token inválido ou expirado');
    }
  });

  // Authenticate opcional — extrai user se token presente, mas não bloqueia
  fastify.decorate('authenticateOptional', async function (request: FastifyRequest) {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return; // sem token, segue sem user
    }

    const token = authHeader.substring(7);

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      if (payload.type === 'access') {
        request.user = payload;
      }
    } catch {
      // Token inválido — ignora silenciosamente no modo opcional
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateOptional: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(authPlugin, { name: 'auth' });
