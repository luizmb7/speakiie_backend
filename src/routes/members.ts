import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { requirePermission, PERMISSIONS, isMember, isServerOwner } from '../services/permission.service';

const updateMemberSchema = z.object({
  roleIds: z.array(z.string().uuid()).optional(),
  nicknameOverride: z.string().max(32).nullable().optional(),
});

export default async function memberRoutes(fastify: FastifyInstance) {
  // ── GET /servers/:id/members ──
  fastify.get('/servers/:id/members', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId } = request.params as { id: string };

    const member = await isMember(fastify.prisma, request.user!.userId, serverId);
    if (!member) throw new NotFoundError('Servidor não encontrado');

    const members = await fastify.prisma.serverMember.findMany({
      where: { serverId },
      include: {
        user: {
          select: {
            id: true,
            nickname: true,
            avatarColor: true,
            isGuest: true,
            lastSeenAt: true,
          },
        },
        roles: {
          include: {
            role: {
              select: {
                id: true,
                name: true,
                color: true,
                position: true,
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    // Formatar resposta
    const formatted = members.map((m) => ({
      id: m.id,
      user: m.user,
      nicknameOverride: m.nicknameOverride,
      roles: m.roles.map((r) => r.role),
      joinedAt: m.joinedAt,
    }));

    return reply.send({ members: formatted });
  });

  // ── PATCH /servers/:id/members/:userId ──
  // Altera cargos ou nickname de um membro
  fastify.patch('/servers/:id/members/:userId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId, userId: targetUserId } = request.params as { id: string; userId: string };
    const body = updateMemberSchema.parse(request.body);
    const actorId = request.user!.userId;

    // Se está alterando roles, precisa de permissão MANAGE_ROLES
    if (body.roleIds !== undefined) {
      await requirePermission(fastify.prisma, actorId, serverId, PERMISSIONS.MANAGE_ROLES);
    }

    // Se está alterando nickname de outro, precisa de permissão; se é o próprio, OK
    if (body.nicknameOverride !== undefined && targetUserId !== actorId) {
      await requirePermission(fastify.prisma, actorId, serverId, PERMISSIONS.MANAGE_ROLES);
    }

    const member = await fastify.prisma.serverMember.findUnique({
      where: { unique_server_user: { serverId, userId: targetUserId } },
    });

    if (!member) throw new NotFoundError('Membro não encontrado');

    // Atualizar roles se fornecido
    if (body.roleIds !== undefined) {
      // Remover roles antigos e inserir novos
      await fastify.prisma.$transaction(async (tx) => {
        await tx.serverMemberRole.deleteMany({
          where: { memberId: member.id },
        });

        if (body.roleIds!.length > 0) {
          await tx.serverMemberRole.createMany({
            data: body.roleIds!.map((roleId) => ({
              memberId: member.id,
              roleId,
            })),
          });
        }
      });
    }

    // Atualizar nickname override
    if (body.nicknameOverride !== undefined) {
      await fastify.prisma.serverMember.update({
        where: { id: member.id },
        data: { nicknameOverride: body.nicknameOverride },
      });
    }

    // Notificar
    fastify.io.to(`server:${serverId}`).emit('member:updated', {
      userId: targetUserId,
      serverId,
    });

    return reply.send({ success: true });
  });

  // ── DELETE /servers/:id/members/:userId ──
  // Sair do servidor (próprio) ou kick (admin)
  fastify.delete('/servers/:id/members/:userId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId, userId: targetUserId } = request.params as { id: string; userId: string };
    const actorId = request.user!.userId;

    // Owner não pode sair do próprio servidor (precisa deletá-lo)
    const ownerCheck = await isServerOwner(fastify.prisma, targetUserId, serverId);
    if (ownerCheck && targetUserId === actorId) {
      throw new ForbiddenError('O dono do servidor não pode sair. Delete o servidor em vez disso.');
    }

    // Se é o próprio usuário saindo, OK. Se é outro, precisa de permissão KICK_MEMBERS
    if (targetUserId !== actorId) {
      await requirePermission(fastify.prisma, actorId, serverId, PERMISSIONS.KICK_MEMBERS);

      // Não pode kickar o owner
      if (ownerCheck) {
        throw new ForbiddenError('Não é possível remover o dono do servidor');
      }
    }

    const member = await fastify.prisma.serverMember.findUnique({
      where: { unique_server_user: { serverId, userId: targetUserId } },
    });

    if (!member) throw new NotFoundError('Membro não encontrado');

    // Remover membro (cascade remove server_member_roles)
    await fastify.prisma.serverMember.delete({
      where: { id: member.id },
    });

    // Notificar
    fastify.io.to(`server:${serverId}`).emit('member:left', {
      userId: targetUserId,
      serverId,
    });

    return reply.status(204).send();
  });
}
