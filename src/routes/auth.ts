import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  hashPassword,
  verifyPassword,
  generateTokens,
  verifyRefreshToken,
  hashRefreshToken,
  generateAvatarColor,
} from '../services/auth.service';
import { BadRequestError, ConflictError, UnauthorizedError } from '../utils/errors';

// ── Schemas de validação ──

const guestSchema = z.object({
  nickname: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/, {
    message: 'Nickname deve conter apenas letras, números, _ ou -',
  }),
});

const registerSchema = z.object({
  nickname: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export default async function authRoutes(fastify: FastifyInstance) {
  // ── POST /auth/guest ──
  // Cria conta guest com apenas um nickname (sem fricção)
  fastify.post('/guest', async (request, reply) => {
    const body = guestSchema.parse(request.body);

    const user = await fastify.prisma.user.create({
      data: {
        nickname: body.nickname,
        isGuest: true,
        avatarColor: generateAvatarColor(),
      },
    });

    const tokens = generateTokens(user.id, true);

    // Salvar refresh token no banco
    await fastify.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashRefreshToken(tokens.refreshToken),
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000), // 180 dias
        deviceInfo: request.headers['user-agent'] || null,
      },
    });

    return reply.status(201).send({
      user: {
        id: user.id,
        nickname: user.nickname,
        isGuest: user.isGuest,
        avatarColor: user.avatarColor,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ── POST /auth/register ──
  // Upgrade de guest → conta completa, OU criação direta de conta
  fastify.post('/register', {
    preHandler: [fastify.authenticateOptional],
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body);

    // Verificar se email já existe
    const existingUser = await fastify.prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser) {
      throw new ConflictError('Email já cadastrado');
    }

    const passwordHash = await hashPassword(body.password);

    // Se veio com token de guest, faz upgrade
    if (request.user?.isGuest) {
      const user = await fastify.prisma.user.update({
        where: { id: request.user.userId },
        data: {
          nickname: body.nickname,
          email: body.email,
          passwordHash,
          isGuest: false,
        },
      });

      const tokens = generateTokens(user.id, false);

      await fastify.prisma.session.create({
        data: {
          userId: user.id,
          refreshTokenHash: hashRefreshToken(tokens.refreshToken),
          expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
          deviceInfo: request.headers['user-agent'] || null,
        },
      });

      return reply.send({
        user: {
          id: user.id,
          nickname: user.nickname,
          email: user.email,
          isGuest: false,
          avatarColor: user.avatarColor,
        },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }

    // Criação direta de conta (sem ser guest)
    const user = await fastify.prisma.user.create({
      data: {
        nickname: body.nickname,
        email: body.email,
        passwordHash,
        isGuest: false,
        avatarColor: generateAvatarColor(),
      },
    });

    const tokens = generateTokens(user.id, false);

    await fastify.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashRefreshToken(tokens.refreshToken),
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        deviceInfo: request.headers['user-agent'] || null,
      },
    });

    return reply.status(201).send({
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        isGuest: false,
        avatarColor: user.avatarColor,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ── POST /auth/login ──
  // Login com email/senha
  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await fastify.prisma.user.findUnique({
      where: { email: body.email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Email ou senha incorretos');
    }

    const validPassword = await verifyPassword(body.password, user.passwordHash);

    if (!validPassword) {
      throw new UnauthorizedError('Email ou senha incorretos');
    }

    // Atualizar last_seen_at
    await fastify.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });

    const tokens = generateTokens(user.id, user.isGuest);

    await fastify.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashRefreshToken(tokens.refreshToken),
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        deviceInfo: request.headers['user-agent'] || null,
      },
    });

    return reply.send({
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        isGuest: user.isGuest,
        avatarColor: user.avatarColor,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ── POST /auth/refresh ──
  // Renova o access token usando um refresh token válido
  fastify.post('/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);

    let payload;
    try {
      payload = verifyRefreshToken(body.refreshToken);
    } catch {
      throw new UnauthorizedError('Refresh token inválido ou expirado');
    }

    // Verificar se a sessão ainda existe no banco
    const tokenHash = hashRefreshToken(body.refreshToken);
    const session = await fastify.prisma.session.findFirst({
      where: {
        userId: payload.userId,
        refreshTokenHash: tokenHash,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      throw new UnauthorizedError('Sessão expirada ou revogada');
    }

    // Buscar dados atualizados do usuário
    const user = await fastify.prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user) {
      throw new UnauthorizedError('Usuário não encontrado');
    }

    // Gerar novos tokens (rotation)
    const tokens = generateTokens(user.id, user.isGuest);

    // Atualizar sessão com novo refresh token
    await fastify.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: hashRefreshToken(tokens.refreshToken),
        expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
      },
    });

    return reply.send({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  });

  // ── GET /auth/me ──
  // Retorna dados do usuário autenticado
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const user = await fastify.prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: {
        id: true,
        nickname: true,
        email: true,
        isGuest: true,
        avatarColor: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError('Usuário não encontrado');
    }

    // Atualizar last_seen_at
    await fastify.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });

    return reply.send({ user });
  });
}
