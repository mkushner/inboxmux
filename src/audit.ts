import { type DB, now } from './db.js';

export interface AuditEntry {
  userId?: number;
  clientId?: string;
  tool: string;
  accounts: string[];
  resultCount?: number;
  error?: string;
}

export function recordAudit(db: DB, e: AuditEntry) {
  db.prepare(
    'INSERT INTO audit_log (at, user_id, client_id, tool, accounts, result_count, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    now(),
    e.userId ?? null,
    e.clientId ?? null,
    e.tool,
    e.accounts.join(','),
    e.resultCount ?? null,
    e.error?.slice(0, 500) ?? null,
  );
}
