import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE pending (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('dcr', 'cimd')),
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE auth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    family_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    rotated_at INTEGER
  );
  CREATE INDEX tokens_family ON tokens(family_id);

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail', 'graph')),
    email TEXT NOT NULL,
    config TEXT NOT NULL,
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs-reauth', 'error')),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, alias)
  );

  CREATE TABLE checkpoints (
    consumer TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    committed TEXT,
    pending TEXT,
    pending_token TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (consumer, account_id)
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    user_id INTEGER,
    client_id TEXT,
    tool TEXT NOT NULL,
    accounts TEXT NOT NULL,
    result_count INTEGER,
    error TEXT
  );
  CREATE INDEX audit_log_at ON audit_log(at);
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const now = () => Math.floor(Date.now() / 1000);

export function purgeExpired(db: DB) {
  const t = now();
  db.prepare('DELETE FROM pending WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t);
}

export function putPending(db: DB, id: string, kind: string, data: unknown, ttlSeconds: number) {
  db.prepare('INSERT INTO pending (id, kind, data, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    kind,
    JSON.stringify(data),
    now() + ttlSeconds,
  );
}

export function takePending<T>(db: DB, id: string, kind: string): T | undefined {
  const row = db
    .prepare('DELETE FROM pending WHERE id = ? AND kind = ? AND expires_at >= ? RETURNING data')
    .get(id, kind, now()) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}

export function peekPending<T>(db: DB, id: string, kind: string): T | undefined {
  const row = db
    .prepare('SELECT data FROM pending WHERE id = ? AND kind = ? AND expires_at >= ?')
    .get(id, kind, now()) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}
