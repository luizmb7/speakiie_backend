import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import ms from 'ms';
import { env } from '../config/env';
import { JwtPayload } from '../plugins/auth';

const SALT_ROUNDS = 12;

/**
 * Hash de senha com bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verifica senha contra hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Gera um par de tokens: access token (curta duração) + refresh token.
 */
export function generateTokens(userId: string, isGuest: boolean) {
  const accessPayload: JwtPayload = { userId, isGuest, type: 'access' };
  const refreshPayload: JwtPayload = { userId, isGuest, type: 'refresh' };

  const accessExpiresIn = Math.floor(ms(env.JWT_EXPIRES_IN as ms.StringValue) / 1000);
  const refreshExpiresIn = Math.floor(ms(env.JWT_REFRESH_EXPIRES_IN as ms.StringValue) / 1000);

  const accessToken = jwt.sign(
    accessPayload as object,
    env.JWT_SECRET,
    { expiresIn: accessExpiresIn }
  );

  const refreshToken = jwt.sign(
    refreshPayload as object,
    env.JWT_SECRET,
    { expiresIn: refreshExpiresIn }
  );

  return { accessToken, refreshToken };
}

/**
 * Verifica e decodifica um refresh token.
 */
export function verifyRefreshToken(token: string): JwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

  if (payload.type !== 'refresh') {
    throw new Error('Tipo de token inválido');
  }

  return payload;
}

/**
 * Gera hash do refresh token para armazenamento seguro.
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Gera uma cor hexadecimal aleatória para avatar padrão.
 * Usa cores vibrantes evitando tons muito escuros ou muito claros.
 */
export function generateAvatarColor(): string {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 60 + Math.floor(Math.random() * 30); // 60-90%
  const lightness = 45 + Math.floor(Math.random() * 20);  // 45-65%

  // Converter HSL para hex
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;

  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };

  return `#${f(0)}${f(8)}${f(4)}`;
}
