import bcrypt from 'bcryptjs';
import { q } from './sqlite.js';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: string;
}

export const ROLES = ['SUPER_ADMIN'] as const;

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 11);
}

export function verifyPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}

export function countUsers(): number {
  const row = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  return row?.n ?? 0;
}

/** Create the single Super Admin. There is intentionally no other path to account creation. */
export function ensureSuperAdmin(username: string, password: string): { created: boolean } {
  const existing = q.get<User>('SELECT * FROM users LIMIT 1');
  if (existing) {
    // keep existing account but refresh password if explicitly re-bootstrapped
    return { created: false };
  }
  if (!password) throw new Error('ADMIN_PASSWORD is required to create the Super Admin on first init');
  q.run(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    username,
    hashPassword(password),
    'SUPER_ADMIN'
  );
  return { created: true };
}

export function setAdminPassword(username: string, password: string) {
  const user = q.get<User>('SELECT * FROM users WHERE username = ?', username) ?? q.get<User>('SELECT * FROM users LIMIT 1');
  if (!user) return ensureSuperAdmin(username, password);
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  return { created: false };
}

export function findUser(username: string): User | undefined {
  return q.get<User>('SELECT * FROM users WHERE username = ?', username);
}

export function authenticate(username: string, password: string): User | null {
  const user = findUser(username);
  if (!user) return null;
  return verifyPassword(password, user.password_hash) ? user : null;
}
