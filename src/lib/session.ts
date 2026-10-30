import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.sessionSecret);
const ALG = 'HS256';

export interface SessionPayload {
  uid: number;
  username: string;
  role: string;
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlDays}d`)
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
    if (typeof payload.uid !== 'number') return null;
    return { uid: payload.uid, username: String(payload.username), role: String(payload.role) };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'avc_session';

export function cookieOptions() {
  const secure = config.baseUrl.startsWith('https://');
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
    path: '/',
  };
}
