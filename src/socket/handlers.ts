import { Server as SocketIOServer, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';

/**
 * Registra todos os event handlers de um socket conectado.
 * Chamado após autenticação bem-sucedida no middleware.
 */
export function registerSocketHandlers(
  io: SocketIOServer,
  socket: Socket,
  prisma: PrismaClient
) {
  const userId = socket.data.userId as string;

  // ── Ao conectar: entrar nas rooms dos servidores do usuário ──
  joinUserRooms(socket, prisma, userId);

  // ── message:send ──
  socket.on('message:send', async (data: { channelId: string; content: string }) => {
    try {
      const { channelId, content } = data;

      if (!channelId || !content || content.trim().length === 0) return;

      // Verificar se o canal existe e buscar servidor
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true, serverId: true, type: true },
      });

      if (!channel || channel.type !== 'text') return;

      // Criar mensagem no banco
      const message = await prisma.message.create({
        data: {
          channelId,
          userId,
          content: content.trim(),
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
      });

      // Atualizar last_seen_at
      await prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
      });

      // Broadcast para todos na room do canal
      io.to(`channel:${channelId}`).emit('message:new', { message });
    } catch (err) {
      console.error('Erro em message:send:', err);
      socket.emit('error', { message: 'Erro ao enviar mensagem' });
    }
  });

  // ── message:edit ──
  socket.on('message:edit', async (data: { messageId: string; content: string }) => {
    try {
      const { messageId, content } = data;

      if (!messageId || !content || content.trim().length === 0) return;

      // Verificar autoria
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { userId: true, channelId: true, deletedAt: true },
      });

      if (!message || message.userId !== userId || message.deletedAt) return;

      const updated = await prisma.message.update({
        where: { id: messageId },
        data: {
          content: content.trim(),
          editedAt: new Date(),
        },
      });

      io.to(`channel:${message.channelId}`).emit('message:edited', {
        messageId: updated.id,
        content: updated.content,
        editedAt: updated.editedAt,
      });
    } catch (err) {
      console.error('Erro em message:edit:', err);
    }
  });

  // ── message:delete ──
  socket.on('message:delete', async (data: { messageId: string }) => {
    try {
      const { messageId } = data;

      if (!messageId) return;

      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { userId: true, channelId: true, deletedAt: true },
      });

      if (!message || message.deletedAt) return;

      // Apenas o autor pode deletar via socket (moderação via REST)
      if (message.userId !== userId) return;

      await prisma.message.update({
        where: { id: messageId },
        data: {
          deletedAt: new Date(),
          content: '',
        },
      });

      io.to(`channel:${message.channelId}`).emit('message:deleted', {
        messageId,
        channelId: message.channelId,
      });
    } catch (err) {
      console.error('Erro em message:delete:', err);
    }
  });

  // ── typing:start ──
  socket.on('typing:start', (data: { channelId: string }) => {
    if (!data.channelId) return;

    socket.to(`channel:${data.channelId}`).emit('typing:update', {
      channelId: data.channelId,
      userId,
      isTyping: true,
    });
  });

  // ── typing:stop ──
  socket.on('typing:stop', (data: { channelId: string }) => {
    if (!data.channelId) return;

    socket.to(`channel:${data.channelId}`).emit('typing:update', {
      channelId: data.channelId,
      userId,
      isTyping: false,
    });
  });

  // ── voice:join_intent ──
  socket.on('voice:join_intent', (data: { channelId: string }) => {
    if (!data.channelId) return;

    // Entrar na room de voz para receber eventos
    socket.join(`server:voice:${data.channelId}`);
  });

  // ── join:channel ──
  // Cliente pede para entrar na room de um canal de texto (para receber mensagens)
  socket.on('join:channel', (data: { channelId: string }) => {
    if (!data.channelId) return;
    socket.join(`channel:${data.channelId}`);
  });

  // ── leave:channel ──
  socket.on('leave:channel', (data: { channelId: string }) => {
    if (!data.channelId) return;
    socket.leave(`channel:${data.channelId}`);
  });

  // ── Desconexão ──
  socket.on('disconnect', async () => {
    try {
      // Atualizar last_seen_at
      await prisma.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
      });

      // Emitir presença offline para todos os servidores
      const memberships = await prisma.serverMember.findMany({
        where: { userId },
        select: { serverId: true },
      });

      for (const m of memberships) {
        io.to(`server:${m.serverId}`).emit('presence:update', {
          userId,
          status: 'offline',
        });
      }
    } catch (err) {
      console.error('Erro no disconnect:', err);
    }
  });
}

/**
 * Ao conectar, entrar automaticamente nas rooms de todos os servidores do usuário.
 * Também emite presença online.
 */
async function joinUserRooms(socket: Socket, prisma: PrismaClient, userId: string) {
  try {
    const memberships = await prisma.serverMember.findMany({
      where: { userId },
      include: {
        server: {
          include: {
            channels: { select: { id: true } },
          },
        },
      },
    });

    for (const m of memberships) {
      // Entrar na room do servidor
      socket.join(`server:${m.serverId}`);

      // Emitir presença online
      socket.to(`server:${m.serverId}`).emit('presence:update', {
        userId,
        status: 'online',
      });
    }
  } catch (err) {
    console.error('Erro ao entrar nas rooms:', err);
  }
}
