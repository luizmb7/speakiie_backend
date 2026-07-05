import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../utils/errors';
import { requirePermission, PERMISSIONS, isMember } from '../services/permission.service';

const createChannelSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).optional(),
  type: z.enum(['text', 'voice']),
  position: z.number().int().min(0).optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(256).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export default async function channelRoutes(fastify: FastifyInstance) {
  // ── GET /servers/:id/channels ──
  fastify.get('/servers/:id/channels', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId } = request.params as { id: string };

    // Verificar se é membro
    const member = await isMember(fastify.prisma, request.user!.userId, serverId);
    if (!member) throw new NotFoundError('Servidor não encontrado');

    const channels = await fastify.prisma.channel.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });

    return reply.send({ channels });
  });

  // ── POST /servers/:id/channels ──
  fastify.post('/servers/:id/channels', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId } = request.params as { id: string };
    const body = createChannelSchema.parse(request.body);

    await requirePermission(fastify.prisma, request.user!.userId, serverId, PERMISSIONS.MANAGE_CHANNELS);

    // Se position não especificado, colocar no final
    let position = body.position;
    if (position === undefined) {
      const lastChannel = await fastify.prisma.channel.findFirst({
        where: { serverId },
        orderBy: { position: 'desc' },
      });
      position = (lastChannel?.position ?? -1) + 1;
    }

    const channel = await fastify.prisma.channel.create({
      data: {
        serverId,
        name: body.name,
        description: body.description || null,
        type: body.type,
        position,
      },
    });

    // Notificar membros do servidor
    fastify.io.to(`server:${serverId}`).emit('channel:created', { channel });

    return reply.status(201).send({ channel });
  });

  // ── PATCH /servers/:id/channels/:channelId ──
  fastify.patch('/servers/:id/channels/:channelId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId, channelId } = request.params as { id: string; channelId: string };
    const body = updateChannelSchema.parse(request.body);

    await requirePermission(fastify.prisma, request.user!.userId, serverId, PERMISSIONS.MANAGE_CHANNELS);

    const channel = await fastify.prisma.channel.findFirst({
      where: { id: channelId, serverId },
    });

    if (!channel) throw new NotFoundError('Canal não encontrado');

    const updated = await fastify.prisma.channel.update({
      where: { id: channelId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.position !== undefined && { position: body.position }),
      },
    });

    fastify.io.to(`server:${serverId}`).emit('channel:updated', { channel: updated });

    return reply.send({ channel: updated });
  });

  // ── DELETE /servers/:id/channels/:channelId ──
  fastify.delete('/servers/:id/channels/:channelId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId, channelId } = request.params as { id: string; channelId: string };

    await requirePermission(fastify.prisma, request.user!.userId, serverId, PERMISSIONS.MANAGE_CHANNELS);

    const channel = await fastify.prisma.channel.findFirst({
      where: { id: channelId, serverId },
    });

    if (!channel) throw new NotFoundError('Canal não encontrado');

    await fastify.prisma.channel.delete({ where: { id: channelId } });

    fastify.io.to(`server:${serverId}`).emit('channel:deleted', { channelId, serverId });

    return reply.status(204).send();
  });
}
