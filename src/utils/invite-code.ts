import crypto from 'crypto';

/**
 * Gera um código de convite aleatório URL-safe.
 * Formato: 8 caracteres alfanuméricos (ex: "xK29fAb3").
 */
export function generateInviteCode(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let code = '';

  for (let i = 0; i < length; i++) {
    code += chars[bytes[i] % chars.length];
  }

  return code;
}
