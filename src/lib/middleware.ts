import type { Request, Response, NextFunction } from 'express';
import { verifySessionToken, SESSION_COOKIE, type SessionPayload } from '../lib/session.js';

declare global {
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const payload = await verifySessionToken(token);
    if (payload) req.session = payload;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}

/** Attach a friendly HTML redirect for page routes; API routes get 401 JSON. */
export function requireAuthPage(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.redirect('/login');
    return;
  }
  next();
}
