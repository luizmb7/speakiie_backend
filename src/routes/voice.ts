import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { requirePermission, PERMISSIONS } from '../services/permission.service';
import { generateVoiceToken } from '../services/livekit.service';
import { env } from '../config/env';

const voiceTokenSchema = z.object({
  channelId: z.string().uuid(),
});

export default async function voiceRoutes(fastify: FastifyInstance) {
  // ── POST /voice/token ──
  // Gera token LiveKit para entrar em um canal de voz
  fastify.post('/voice/token', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const body = voiceTokenSchema.parse(request.body);
    const userId = request.user!.userId;

    // Verificar se o canal existe e é de voz
    const channel = await fastify.prisma.channel.findUnique({
      where: { id: body.channelId },
      select: { id: true, serverId: true, type: true, name: true },
    });

    if (!channel) throw new NotFoundError('Canal não encontrado');
    if (channel.type !== 'voice') throw new ForbiddenError('Este não é um canal de voz');

    // Verificar permissão de conectar voz
    await requirePermission(fastify.prisma, userId, channel.serverId, PERMISSIONS.CONNECT_VOICE);

    // Buscar nickname do usuário
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { nickname: true },
    });

    if (!user) throw new NotFoundError('Usuário não encontrado');

    // Verificar nickname override no servidor
    const member = await fastify.prisma.serverMember.findUnique({
      where: { unique_server_user: { serverId: channel.serverId, userId } },
      select: { nicknameOverride: true },
    });

    const displayName = member?.nicknameOverride || user.nickname;

    // Gerar token LiveKit
    const token = await generateVoiceToken(userId, displayName, channel.id);

    return reply.send({
      token,
      wsUrl: env.LIVEKIT_WS_URL,
      channelId: channel.id,
      channelName: channel.name,
    });
  });
}
