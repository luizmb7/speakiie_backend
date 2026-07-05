import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { requirePermission, PERMISSIONS, isMember } from '../services/permission.service';

const getMessagesSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  direction: z.enum(['before', 'after']).default('before'),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

export default async function messageRoutes(fastify: FastifyInstance) {
  // ── GET /channels/:id/messages ──
  // Paginação cursor-based
  fastify.get('/channels/:id/messages', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: channelId } = request.params as { id: string };
    const query = getMessagesSchema.parse(request.query);

    // Verificar se o canal existe e o usuário é membro do servidor
    const channel = await fastify.prisma.channel.findUnique({
      where: { id: channelId },
      select: { serverId: true },
    });

    if (!channel) throw new NotFoundError('Canal não encontrado');

    const member = await isMember(fastify.prisma, request.user!.userId, channel.serverId);
    if (!member) throw new ForbiddenError('Não é membro do servidor');

    // Construir query com cursor
    let cursorCondition = {};

    if (query.cursor) {
      const cursorMessage = await fastify.prisma.message.findUnique({
        where: { id: query.cursor },
        select: { createdAt: true },
      });

      if (cursorMessage) {
        cursorCondition = {
          createdAt: query.direction === 'before'
            ? { lt: cursorMessage.createdAt }
            : { gt: cursorMessage.createdAt },
        };
      }
    }

    const messages = await fastify.prisma.message.findMany({
      where: {
        channelId,
        deletedAt: null, // Filtrar soft-deletes
        ...cursorCondition,
      },
      include: {
        user: {
          select: {
            id: true,
            nickname: true,
            avatarColor: true,
            isGuest: true,
          },
        },
      },
      orderBy: { createdAt: query.direction === 'before' ? 'desc' : 'asc' },
      take: query.limit,
    });

    // Para direction=before, a query retorna em ordem DESC — reverter para cronológica
    const sorted = query.direction === 'before' ? messages.reverse() : messages;

    // Incluir mensagens soft-deleted como placeholders
    const deletedMessages = await fastify.prisma.message.findMany({
      where: {
        channelId,
        deletedAt: { not: null },
        ...cursorCondition,
      },
      select: {
        id: true,
        channelId: true,
        createdAt: true,
        deletedAt: true,
      },
      orderBy: { createdAt: query.direction === 'before' ? 'desc' : 'asc' },
      take: query.limit,
    });

    return reply.send({
      messages: sorted,
      hasMore: messages.length === query.limit,
    });
  });

  // ── PATCH /messages/:id ──
  // Edita mensagem (apenas o autor)
  fastify.patch('/messages/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: messageId } = request.params as { id: string };
    const body = editMessageSchema.parse(request.body);
    const userId = request.user!.userId;

    const message = await fastify.prisma.message.findUnique({
      where: { id: messageId },
      select: { userId: true, channelId: true, deletedAt: true },
    });

    if (!message || message.deletedAt) throw new NotFoundError('Mensagem não encontrada');
    if (message.userId !== userId) throw new ForbiddenError('Apenas o autor pode editar');

    const updated = await fastify.prisma.message.update({
      where: { id: messageId },
      data: {
        content: body.content,
        editedAt: new Date(),
      },
      include: {
        user: {
          select: { id: true, nickname: true, avatarColor: true },
        },
      },
    });

    // Notificar via Socket.IO
    fastify.io.to(`channel:${message.channelId}`).emit('message:edited', {
      messageId: updated.id,
      content: updated.content,
      editedAt: updated.editedAt,
    });

    return reply.send({ message: updated });
  });

  // ── DELETE /messages/:id ──
  // Soft-delete (autor ou moderador com permissão DELETE_MESSAGES)
  fastify.delete('/messages/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: messageId } = request.params as { id: string };
    const userId = request.user!.userId;

    const message = await fastify.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        channel: { select: { serverId: true } },
      },
    });

    if (!message || message.deletedAt) throw new NotFoundError('Mensagem não encontrada');

    // Autor pode deletar sua própria mensagem; moderador precisa de permissão
    if (message.userId !== userId) {
      await requirePermission(
        fastify.prisma,
        userId,
        message.channel.serverId,
        PERMISSIONS.DELETE_MESSAGES
      );
    }

    // Soft-delete: preencher deleted_at e limpar conteúdo
    await fastify.prisma.message.update({
      where: { id: messageId },
      data: {
        deletedAt: new Date(),
        content: '', // Limpar conteúdo por privacidade
      },
    });

    // Notificar via Socket.IO
    fastify.io.to(`channel:${message.channelId}`).emit('message:deleted', {
      messageId,
      channelId: message.channelId,
    });

    return reply.status(204).send();
  });
}
