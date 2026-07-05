import { AccessToken, VideoGrant } from 'livekit-server-sdk';
import { env } from '../config/env';

/**
 * Gera um Access Token do LiveKit para um usuário entrar em um canal de voz.
 *
 * @param userId    - ID do usuário (usado como identity no LiveKit)
 * @param nickname  - Nickname do usuário (usado como nome no LiveKit)
 * @param roomName  - Nome da room (normalmente o channel ID)
 * @param ttlSeconds - Tempo de vida do token em segundos (padrão: 10 min)
 */
export async function generateVoiceToken(
  userId: string,
  nickname: string,
  roomName: string,
  ttlSeconds = 600
): Promise<string> {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: userId,
    name: nickname,
    ttl: ttlSeconds,
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  };

  token.addGrant(grant);

  return await token.toJwt();
}
