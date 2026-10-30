import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate, countUsers } from '../lib/auth.js';
import { setAdminPassword } from '../lib/auth.js';
import { createSessionToken, verifySessionToken, SESSION_COOKIE, cookieOptions } from '../lib/session.js';
import { loadSession, requireAuth } from '../lib/middleware.js';
import { logger } from '../lib/log.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = authenticate(String(username), String(password));
  if (!user) {
    logger.warn('AUTH', `failed login for username=${String(username)}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  logger.info('AUTH', `login ok user=${user.username}`);
  if (!countUsers()) {
    // first boot: ensure admin exists (handled by scripts/init-db, but keep safe)
    setAdminPassword(user.username, String(password));
  }
  const token = await createSessionToken({ uid: user.id, username: user.username, role: user.role });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: { username: req.session.username, role: req.session.role } });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
  if (!current || !next) return res.status(400).json({ error: 'current and next password required' });
  if (String(next).length < 8) return res.status(400).json({ error: 'new password must be at least 8 characters' });
  const user = authenticate(req.session!.username, String(current));
  if (!user) return res.status(400).json({ error: 'current password is wrong' });
  q_run_update_password(user.id, String(next));
  logger.info('AUTH', `password changed for ${user.username}`);
  res.json({ ok: true });
});

// small direct update to avoid importing q here (keeps this file focused)
import { q } from '../lib/sqlite.js';
function q_run_update_password(id: number, pw: string) {
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pw, 11), id);
}
