import type { Account, Accounts } from '../accounts.js';
import { randomToken } from '../crypto.js';
import { type DB, now } from '../db.js';
import { HttpError } from '../providers/oauth.js';
import { AuthError, type Checkpoint, type MailProvider, UserError } from './types.js';

const ACCOUNT_TIMEOUT_MS = 45_000;
export const CONSUMER_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export type AccountSelector = 'all' | string[];

export interface AccountError {
  account: string;
  error: string;
}

export interface FanOut<T> {
  results: Array<{ account: Account; value: T }>;
  errors: AccountError[];
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MailService {
  constructor(
    private readonly db: DB,
    private readonly accounts: Accounts,
  ) {}

  listAccounts(userId: number): Account[] {
    return this.accounts.list(userId);
  }

  resolve(userId: number, selector: AccountSelector): Account[] {
    const all = this.accounts.list(userId);
    if (selector === 'all') return all;
    const unknown = selector.filter((alias) => !all.some((a) => a.alias === alias));
    if (unknown.length > 0) throw new UserError(`Unknown account alias: ${unknown.join(', ')}`);
    return all.filter((a) => selector.includes(a.alias));
  }

  splitId(userId: number, namespacedId: string): { account: Account; providerId: string } {
    const sep = namespacedId.indexOf(':');
    if (sep <= 0) throw new UserError(`Malformed id "${namespacedId}": expected "<alias>:<id>"`);
    const [account] = this.resolve(userId, [namespacedId.slice(0, sep)]);
    return { account: account as Account, providerId: namespacedId.slice(sep + 1) };
  }

  async run<T>(account: Account, fn: (provider: MailProvider) => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ACCOUNT_TIMEOUT_MS / 1000}s`)),
        ACCOUNT_TIMEOUT_MS,
      );
    });
    try {
      const value = await Promise.race([fn(this.accounts.provider(account)), timeout]);
      if (account.status !== 'ok') this.accounts.setStatus(account.id, 'ok');
      return value;
    } catch (err) {
      if (err instanceof AuthError) this.accounts.setStatus(account.id, 'needs-reauth', err.message);
      else if (!(err instanceof UserError) && !(err instanceof HttpError && err.status < 500)) {
        this.accounts.setStatus(account.id, 'error', errorMessage(err));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fanOut<T>(
    accounts: Account[],
    fn: (provider: MailProvider, account: Account) => Promise<T>,
  ): Promise<FanOut<T>> {
    const settled = await Promise.allSettled(accounts.map((a) => this.run(a, (p) => fn(p, a))));
    const out: FanOut<T> = { results: [], errors: [] };
    settled.forEach((s, i) => {
      const account = accounts[i] as Account;
      if (s.status === 'fulfilled') out.results.push({ account, value: s.value });
      else out.errors.push({ account: account.alias, error: errorMessage(s.reason) });
    });
    return out;
  }

  committedCheckpoint(consumer: string, accountId: number): Checkpoint | undefined {
    const row = this.db
      .prepare('SELECT committed FROM checkpoints WHERE consumer = ? AND account_id = ?')
      .get(consumer, accountId) as { committed: string | null } | undefined;
    return row?.committed ? (JSON.parse(row.committed) as Checkpoint) : undefined;
  }

  stagePending(consumer: string, entries: Array<{ accountId: number; checkpoint: Checkpoint }>): string {
    const token = randomToken('ack_');
    const upsert = this.db.prepare(
      `INSERT INTO checkpoints (consumer, account_id, pending, pending_token, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer, account_id) DO UPDATE SET
         pending = excluded.pending, pending_token = excluded.pending_token, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const e of entries) upsert.run(consumer, e.accountId, JSON.stringify(e.checkpoint), token, now());
    })();
    return token;
  }

  ack(userId: number, consumer: string, token: string): string[] {
    const rows = this.db
      .prepare(
        `UPDATE checkpoints SET committed = pending, pending = NULL, pending_token = NULL, updated_at = ?
         WHERE consumer = ? AND pending_token = ?
           AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
         RETURNING account_id`,
      )
      .all(now(), consumer, token, userId) as Array<{ account_id: number }>;
    const aliases = new Map(this.accounts.list(userId).map((a) => [a.id, a.alias]));
    return rows.map((r) => aliases.get(r.account_id) as string);
  }
}
