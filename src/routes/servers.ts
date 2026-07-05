import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateInviteCode } from '../utils/invite-code';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { requirePermission, PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, ALL_PERMISSIONS } from '../services/permission.service';

// ── Schemas ──

const createServerSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).optional(),
});

const updateServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(256).nullable().optional(),
  iconUrl: z.string().url().max(512).nullable().optional(),
});

const joinServerSchema = z.object({
  inviteCode: z.string().min(1).max(12),
});

export default async function serverRoutes(fastify: FastifyInstance) {
  // ── GET /servers ──
  // Lista servidores do usuário autenticado
  fastify.get('/servers', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const servers = await fastify.prisma.server.findMany({
      where: {
        members: {
          some: { userId: request.user!.userId },
        },
      },
      include: {
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ servers });
  });

  // ── POST /servers ──
  // Cria um novo servidor com canais e cargos padrão
  fastify.post('/servers', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const body = createServerSchema.parse(request.body);
    const userId = request.user!.userId;

    // Gerar invite code único
    let inviteCode: string;
    let attempts = 0;
    do {
      inviteCode = generateInviteCode();
      const existing = await fastify.prisma.server.findUnique({
        where: { inviteCode },
      });
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    // Criar servidor com canais e cargos padrão numa transação
    const server = await fastify.prisma.$transaction(async (tx) => {
      // 1. Criar servidor
      const newServer = await tx.server.create({
        data: {
          name: body.name,
          description: body.description || null,
          ownerId: userId,
          inviteCode,
        },
      });

      // 2. Criar cargo "Admin" (para o owner)
      const adminRole = await tx.role.create({
        data: {
          serverId: newServer.id,
          name: 'Admin',
          color: '#E74C3C',
          isDefault: false,
          position: 100,
          permissions: {
            createMany: {
              data: ALL_PERMISSIONS.map((p) => ({ permission: p })),
            },
          },
        },
      });

      // 3. Criar cargo "Membro" (default para novos membros)
      const memberRole = await tx.role.create({
        data: {
          serverId: newServer.id,
          name: 'Membro',
          color: '#99AAB5',
          isDefault: true,
          position: 0,
          permissions: {
            createMany: {
              data: DEFAULT_MEMBER_PERMISSIONS.map((p) => ({ permission: p })),
            },
          },
        },
      });

      // 4. Adicionar owner como membro com cargo Admin
      const ownerMember = await tx.serverMember.create({
        data: {
          serverId: newServer.id,
          userId,
          roles: {
            create: { roleId: adminRole.id },
          },
        },
      });

      // 5. Criar canal de texto "geral" e canal de voz "Voz Geral"
      await tx.channel.createMany({
        data: [
          {
            serverId: newServer.id,
            name: 'geral',
            type: 'text',
            position: 0,
          },
          {
            serverId: newServer.id,
            name: 'Voz Geral',
            type: 'voice',
            position: 1,
          },
        ],
      });

      return newServer;
    });

    // Buscar servidor completo para resposta
    const fullServer = await fastify.prisma.server.findUnique({
      where: { id: server.id },
      include: {
        channels: { orderBy: { position: 'asc' } },
        roles: { orderBy: { position: 'desc' } },
        _count: { select: { members: true } },
      },
    });

    return reply.status(201).send({ server: fullServer });
  });

  // ── PATCH /servers/:id ──
  // Edita servidor (nome, descrição, ícone)
  fastify.patch('/servers/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateServerSchema.parse(request.body);

    await requirePermission(fastify.prisma, request.user!.userId, id, PERMISSIONS.MANAGE_SERVER);

    const server = await fastify.prisma.server.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.iconUrl !== undefined && { iconUrl: body.iconUrl }),
      },
    });

    return reply.send({ server });
  });

  // ── DELETE /servers/:id ──
  // Deleta servidor (apenas owner)
  fastify.delete('/servers/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const server = await fastify.prisma.server.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!server) throw new NotFoundError('Servidor não encontrado');
    if (server.ownerId !== userId) throw new ForbiddenError('Apenas o dono pode deletar o servidor');

    await fastify.prisma.server.delete({ where: { id } });

    // Notificar membros via Socket.IO
    fastify.io.to(`server:${id}`).emit('server:deleted', { serverId: id });

    return reply.status(204).send();
  });

  // ── POST /servers/join ──
  // Entra em um servidor via código de convite
  fastify.post('/servers/join', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const body = joinServerSchema.parse(request.body);
    const userId = request.user!.userId;

    const server = await fastify.prisma.server.findUnique({
      where: { inviteCode: body.inviteCode },
      include: {
        roles: { where: { isDefault: true }, take: 1 },
      },
    });

    if (!server) throw new NotFoundError('Código de convite inválido');

    // Verificar se já é membro
    const existing = await fastify.prisma.serverMember.findUnique({
      where: { unique_server_user: { serverId: server.id, userId } },
    });

    if (existing) {
      return reply.send({ server, message: 'Já é membro deste servidor' });
    }

    // Adicionar como membro com cargo padrão
    const defaultRole = server.roles[0];

    await fastify.prisma.serverMember.create({
      data: {
        serverId: server.id,
        userId,
        ...(defaultRole && {
          roles: {
            create: { roleId: defaultRole.id },
          },
        }),
      },
    });

    // Notificar membros existentes
    fastify.io.to(`server:${server.id}`).emit('member:joined', {
      serverId: server.id,
      userId,
    });

    // Buscar servidor completo
    const fullServer = await fastify.prisma.server.findUnique({
      where: { id: server.id },
      include: {
        channels: { orderBy: { position: 'asc' } },
        _count: { select: { members: true } },
      },
    });

    return reply.send({ server: fullServer });
  });
}
