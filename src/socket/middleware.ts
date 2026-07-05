import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload } from '../plugins/auth';

/**
 * Middleware de autenticação para conexões Socket.IO.
 * Valida o JWT enviado via auth.token e popula socket.data com o payload.
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void) {
  const token = socket.handshake.auth?.token as string | undefined;

  if (!token) {
    return next(new Error('Token não fornecido'));
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    if (payload.type !== 'access') {
      return next(new Error('Tipo de token inválido'));
    }

    // Armazenar dados do usuário no socket
    socket.data.userId = payload.userId;
    socket.data.isGuest = payload.isGuest;

    next();
  } catch {
    next(new Error('Token inválido ou expirado'));
  }
}
