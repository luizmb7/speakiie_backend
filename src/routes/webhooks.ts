import { FastifyInstance } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import { env } from '../config/env';

export default async function webhookRoutes(fastify: FastifyInstance) {
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

  // ── POST /webhooks/livekit ──
  // Recebe webhooks do LiveKit e emite eventos via Socket.IO
  fastify.post('/webhooks/livekit', {
    config: {
      rawBody: true, // LiveKit webhooks precisam do body raw para validação de assinatura
    },
  }, async (request, reply) => {
    try {
      const body = request.body as string;
      const authHeader = request.headers.authorization as string;

      // Validar assinatura do webhook
      const event = await receiver.receive(body, authHeader);

      fastify.log.info({ event: event.event }, 'LiveKit webhook recebido');

      switch (event.event) {
        case 'participant_joined': {
          const participant = event.participant;
          const room = event.room;

          if (participant && room) {
            fastify.io.to(`server:voice:${room.name}`).emit('voice:user_joined', {
              channelId: room.name,
              userId: participant.identity,
            });

            fastify.log.info({
              userId: participant.identity,
              channelId: room.name,
            }, 'Participante entrou no canal de voz');
          }
          break;
        }

        case 'participant_left': {
          const participant = event.participant;
          const room = event.room;

          if (participant && room) {
            fastify.io.to(`server:voice:${room.name}`).emit('voice:user_left', {
              channelId: room.name,
              userId: participant.identity,
            });

            fastify.log.info({
              userId: participant.identity,
              channelId: room.name,
            }, 'Participante saiu do canal de voz');
          }
          break;
        }

        // Active speaker detection
        case 'track_published': {
          // O evento de active speaker vem separadamente;
          // aqui apenas logamos a publicação de track
          const participant = event.participant;
          const room = event.room;

          if (participant && room) {
            fastify.log.debug({
              userId: participant.identity,
              channelId: room.name,
            }, 'Track publicada');
          }
          break;
        }

        default:
          fastify.log.debug({ event: event.event }, 'Webhook não tratado');
      }

      return reply.status(200).send({ received: true });
    } catch (err) {
      fastify.log.error(err, 'Erro ao processar webhook do LiveKit');
      return reply.status(400).send({ error: 'Webhook inválido' });
    }
  });
}
