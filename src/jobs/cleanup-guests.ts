import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { env } from '../config/env';

/**
 * Job de limpeza de contas guest expiradas.
 * Roda diariamente às 3:00 AM.
 *
 * - Identifica guests com last_seen_at há mais de GUEST_EXPIRY_DAYS dias
 * - Anonimiza mensagens (limpa o conteúdo e marca como de "usuário removido")
 * - Remove registros de server_members (cascade remove server_member_roles)
 * - Remove o registro de users
 */
export function startGuestCleanupJob(prisma: PrismaClient) {
  const schedule = '0 3 * * *'; // Diário às 3:00 AM

  cron.schedule(schedule, async () => {
    console.log('[CLEANUP] Iniciando limpeza de guests expirados...');

    try {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() - env.GUEST_EXPIRY_DAYS);

      // Buscar guests expirados
      const expiredGuests = await prisma.user.findMany({
        where: {
          isGuest: true,
          lastSeenAt: { lt: expiryDate },
        },
        select: { id: true, nickname: true, lastSeenAt: true },
      });

      if (expiredGuests.length === 0) {
        console.log('[CLEANUP] Nenhum guest expirado encontrado.');
        return;
      }

      console.log(`[CLEANUP] Encontrados ${expiredGuests.length} guests expirados.`);

      for (const guest of expiredGuests) {
        try {
          await prisma.$transaction(async (tx) => {
            // 1. Anonimizar mensagens: soft-delete e limpar conteúdo
            await tx.message.updateMany({
              where: { userId: guest.id },
              data: {
                deletedAt: new Date(),
                content: '[Mensagem de usuário removido]',
              },
            });

            // 2. Remover sessões
            await tx.session.deleteMany({
              where: { userId: guest.id },
            });

            // 3. Remover memberships (cascade remove server_member_roles)
            await tx.serverMember.deleteMany({
              where: { userId: guest.id },
            });

            // 4. Remover o usuário
            await tx.user.delete({
              where: { id: guest.id },
            });
          });

          console.log(`[CLEANUP] Guest removido: ${guest.nickname} (${guest.id}), último acesso: ${guest.lastSeenAt.toISOString()}`);
        } catch (err) {
          console.error(`[CLEANUP] Erro ao remover guest ${guest.id}:`, err);
        }
      }

      console.log(`[CLEANUP] Limpeza concluída. ${expiredGuests.length} guests processados.`);
    } catch (err) {
      console.error('[CLEANUP] Erro geral na limpeza de guests:', err);
    }
  });

  console.log(`✅ Job de limpeza de guests agendado (cron: ${schedule}, expiry: ${env.GUEST_EXPIRY_DAYS} dias)`);
}
