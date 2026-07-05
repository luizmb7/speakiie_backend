import { PrismaClient } from '@prisma/client';
import { ForbiddenError } from '../utils/errors';

/**
 * Lista de permissões disponíveis no sistema.
 */
export const PERMISSIONS = {
  // Servidor
  MANAGE_SERVER: 'manage_server',
  MANAGE_CHANNELS: 'manage_channels',
  MANAGE_ROLES: 'manage_roles',

  // Membros
  KICK_MEMBERS: 'kick_members',
  MUTE_MEMBERS: 'mute_members',

  // Chat
  SEND_MESSAGES: 'send_messages',
  DELETE_MESSAGES: 'delete_messages',

  // Voz
  CONNECT_VOICE: 'connect_voice',
  SPEAK: 'speak',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Permissões padrão para o cargo "Membro" (default role).
 */
export const DEFAULT_MEMBER_PERMISSIONS: Permission[] = [
  PERMISSIONS.SEND_MESSAGES,
  PERMISSIONS.CONNECT_VOICE,
  PERMISSIONS.SPEAK,
];

/**
 * Todas as permissões — atribuídas ao cargo "Admin".
 */
export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * Verifica se um membro tem uma determinada permissão.
 * O owner do servidor tem TODAS as permissões automaticamente.
 */
export async function hasPermission(
  prisma: PrismaClient,
  userId: string,
  serverId: string,
  permission: Permission
): Promise<boolean> {
  // Owner sempre tem todas as permissões
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });

  if (server?.ownerId === userId) return true;

  // Buscar todas as permissões dos cargos do membro (OR de todos os roles)
  const member = await prisma.serverMember.findUnique({
    where: { unique_server_user: { serverId, userId } },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: true,
            },
          },
        },
      },
    },
  });

  if (!member) return false;

  // Agregar permissões de todos os cargos
  const allPermissions = new Set<string>();
  for (const memberRole of member.roles) {
    for (const perm of memberRole.role.permissions) {
      allPermissions.add(perm.permission);
    }
  }

  return allPermissions.has(permission);
}

/**
 * Verifica permissão e lança ForbiddenError se não tiver.
 */
export async function requirePermission(
  prisma: PrismaClient,
  userId: string,
  serverId: string,
  permission: Permission
): Promise<void> {
  const allowed = await hasPermission(prisma, userId, serverId, permission);

  if (!allowed) {
    throw new ForbiddenError(`Permissão necessária: ${permission}`);
  }
}

/**
 * Verifica se o usuário é o owner do servidor.
 */
export async function isServerOwner(
  prisma: PrismaClient,
  userId: string,
  serverId: string
): Promise<boolean> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { ownerId: true },
  });

  return server?.ownerId === userId;
}

/**
 * Verifica se o usuário é membro do servidor.
 */
export async function isMember(
  prisma: PrismaClient,
  userId: string,
  serverId: string
): Promise<boolean> {
  const member = await prisma.serverMember.findUnique({
    where: { unique_server_user: { serverId, userId } },
  });

  return !!member;
}
