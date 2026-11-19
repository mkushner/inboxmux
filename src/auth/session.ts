import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { randomToken, sha256 } from '../crypto.js';
import { type DB, now } from '../db.js';

export const SESSION_COOKIE = '__Host-inboxmux';
const SESSION_TTL = 7 * 86_400;

export interface Session {
  userId: number;
  email: string;
  csrf: string;
}

export function upsertUser(db: DB, email: string): number {
  const row = db
    .prepare(
      `INSERT INTO users (email, created_at) VALUES (?, ?)
       ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id`,
    )
    .get(email.toLowerCase(), now()) as { id: number };
  return row.id;
}

export function createSession(db: DB, userId: number, res: Response) {
  const id = randomToken();
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(id),
    userId,
    randomToken(),
    now() + SESSION_TTL,
  );
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL * 1000,
  });
}

export function readSession(db: DB, req: Request, ownerEmails: string[]): Session | undefined {
  const id = req.cookies?.[SESSION_COOKIE];
  if (typeof id !== 'string') return undefined;
  const row = db
    .prepare(
      `SELECT s.user_id, s.csrf, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at >= ?`,
    )
    .get(sha256(id), now()) as { user_id: number; csrf: string; email: string } | undefined;
  if (!row || !ownerEmails.includes(row.email)) return undefined;
  return { userId: row.user_id, email: row.email, csrf: row.csrf };
}

export function destroySession(db: DB, req: Request, res: Response) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (typeof id === 'string') db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(id));
  res.clearCookie(SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
}

export function csrfValid(session: Session, req: Request): boolean {
  const sent = req.body?.csrf;
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(session.csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}
