import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../utils/errors';
import { requirePermission, PERMISSIONS, Permission } from '../services/permission.service';

const createRoleSchema = z.object({
  name: z.string().min(1).max(32),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#99AAB5'),
  permissions: z.array(z.string()).default([]),
  position: z.number().int().min(0).optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  permissions: z.array(z.string()).optional(),
  position: z.number().int().min(0).optional(),
});

export default async function roleRoutes(fastify: FastifyInstance) {
  // ── GET /servers/:id/roles ──
  fastify.get('/servers/:id/roles', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId } = request.params as { id: string };

    const roles = await fastify.prisma.role.findMany({
      where: { serverId },
      include: {
        permissions: { select: { permission: true } },
        _count: { select: { members: true } },
      },
      orderBy: { position: 'desc' },
    });

    const formatted = roles.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      isDefault: r.isDefault,
      position: r.position,
      permissions: r.permissions.map((p) => p.permission),
      memberCount: r._count.members,
    }));

    return reply.send({ roles: formatted });
  });

  // ── POST /servers/:id/roles ──
  fastify.post('/servers/:id/roles', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId } = request.params as { id: string };
    const body = createRoleSchema.parse(request.body);

    await requirePermission(fastify.prisma, request.user!.userId, serverId, PERMISSIONS.MANAGE_ROLES);

    // Se position não especificado, colocar acima dos existentes (exceto admin)
    let position = body.position;
    if (position === undefined) {
      const highestRole = await fastify.prisma.role.findFirst({
        where: { serverId },
        orderBy: { position: 'desc' },
      });
      position = (highestRole?.position ?? 0) + 1;
    }

    const role = await fastify.prisma.role.create({
      data: {
        serverId,
        name: body.name,
        color: body.color,
        position,
        permissions: {
          createMany: {
            data: body.permissions.map((p) => ({ permission: p })),
          },
        },
      },
      include: {
        permissions: { select: { permission: true } },
      },
    });

    return reply.status(201).send({
      role: {
        ...role,
        permissions: role.permissions.map((p) => p.permission),
      },
    });
  });

  // ── PATCH /servers/:id/roles/:roleId ──
  fastify.patch('/servers/:id/roles/:roleId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId, roleId } = request.params as { id: string; roleId: string };
    const body = updateRoleSchema.parse(request.body);

    await requirePermission(fastify.prisma, request.user!.userId, serverId, PERMISSIONS.MANAGE_ROLES);

    const role = await fastify.prisma.role.findFirst({
      where: { id: roleId, serverId },
    });

    if (!role) throw new NotFoundError('Cargo não encontrado');

    await fastify.prisma.$transaction(async (tx) => {
      // Atualizar campos básicos
      await tx.role.update({
        where: { id: roleId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.position !== undefined && { position: body.position }),
        },
      });

      // Atualizar permissões se fornecidas
      if (body.permissions !== undefined) {
        await tx.rolePermission.deleteMany({ where: { roleId } });

        if (body.permissions.length > 0) {
          await tx.rolePermission.createMany({
            data: body.permissions.map((p) => ({ roleId, permission: p })),
          });
        }
      }
    });

    // Buscar role atualizado
    const updated = await fastify.prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { select: { permission: true } } },
    });

    return reply.send({
      role: {
        ...updated,
        permissions: updated?.permissions.map((p) => p.permission),
      },
    });
  });

  // ── DELETE /servers/:id/roles/:roleId ──
  fastify.delete('/servers/:id/roles/:roleId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { id: serverId, roleId } = request.params as { id: string; roleId: string };

    await requirePermission(fastify.prisma, request.user!.userId, serverId, PERMISSIONS.MANAGE_ROLES);

    const role = await fastify.prisma.role.findFirst({
      where: { id: roleId, serverId },
    });

    if (!role) throw new NotFoundError('Cargo não encontrado');

    // Não permitir deletar o cargo padrão
    if (role.isDefault) {
      throw new NotFoundError('Não é possível deletar o cargo padrão');
    }

    await fastify.prisma.role.delete({ where: { id: roleId } });

    return reply.status(204).send();
  });
}
