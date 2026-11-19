import { googleClient, microsoftClient } from './auth/upstream.js';
import type { Config } from './config.js';
import type { Keyring } from './crypto.js';
import { type DB, now } from './db.js';
import type { MailProvider } from './mail/types.js';
import { GmailProvider } from './providers/gmail.js';
import { GraphProvider } from './providers/graph.js';
import { type ImapConfig, ImapProvider } from './providers/imap.js';
import { RefreshingToken } from './providers/oauth.js';

export type ProviderKind = 'imap' | 'gmail' | 'graph';
export type AccountStatus = 'ok' | 'needs-reauth' | 'error';

export interface Account {
  id: number;
  userId: number;
  alias: string;
  provider: ProviderKind;
  email: string;
  config: Record<string, unknown>;
  status: AccountStatus;
  lastError?: string;
}

export type AccountSecret = { password: string } | { refreshToken: string };

interface Row {
  id: number;
  user_id: number;
  alias: string;
  provider: ProviderKind;
  email: string;
  config: string;
  secret: string;
  status: AccountStatus;
  last_error: string | null;
}

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const toAccount = (r: Row): Account => ({
  id: r.id,
  userId: r.user_id,
  alias: r.alias,
  provider: r.provider,
  email: r.email,
  config: JSON.parse(r.config),
  status: r.status,
  lastError: r.last_error ?? undefined,
});

export class Accounts {
  private readonly providers = new Map<number, MailProvider>();

  constructor(
    private readonly db: DB,
    private readonly keyring: Keyring,
    private readonly config: Config,
  ) {}

  list(userId: number): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY alias')
      .all(userId) as Row[];
    return rows.map(toAccount);
  }

  get(userId: number, id: number): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE user_id = ? AND id = ?').get(userId, id) as
      | Row
      | undefined;
    return row ? toAccount(row) : undefined;
  }

  create(
    userId: number,
    input: { alias: string; provider: ProviderKind; email: string; config: object; secret: AccountSecret },
  ): Account {
    if (!ALIAS_PATTERN.test(input.alias)) {
      throw new Error('Alias must be 1-32 characters: lowercase letters, digits and dashes');
    }
    const t = now();
    const row = this.db
      .prepare(
        `INSERT INTO accounts (user_id, alias, provider, email, config, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        userId,
        input.alias,
        input.provider,
        input.email,
        JSON.stringify(input.config),
        this.keyring.encrypt(JSON.stringify(input.secret)),
        t,
        t,
      ) as Row;
    return toAccount(row);
  }

  updateSecret(id: number, secret: AccountSecret) {
    this.db
      .prepare(
        "UPDATE accounts SET secret = ?, status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(this.keyring.encrypt(JSON.stringify(secret)), now(), id);
    this.providers.delete(id);
  }

  remove(userId: number, id: number) {
    this.db.prepare('DELETE FROM accounts WHERE user_id = ? AND id = ?').run(userId, id);
    this.providers.delete(id);
  }

  setStatus(id: number, status: AccountStatus, error?: string) {
    this.db
      .prepare(
        'UPDATE accounts SET status = ?, last_error = ? WHERE id = ? AND (status != ? OR last_error IS NOT ?)',
      )
      .run(status, error ?? null, id, status, error ?? null);
  }

  reencryptAll(): number {
    const update = this.db.prepare('UPDATE accounts SET secret = ? WHERE id = ?');
    let changed = 0;
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id, secret FROM accounts').all() as Array<{
        id: number;
        secret: string;
      }>;
      for (const row of rows) {
        if (this.keyring.isCurrent(row.secret)) continue;
        update.run(this.keyring.encrypt(this.keyring.decrypt(row.secret)), row.id);
        changed++;
      }
    })();
    return changed;
  }

  provider(account: Account): MailProvider {
    const cached = this.providers.get(account.id);
    if (cached) return cached;
    const provider = this.build(account);
    this.providers.set(account.id, provider);
    return provider;
  }

  private readSecret(id: number): Record<string, string> | undefined {
    const row = this.db.prepare('SELECT secret FROM accounts WHERE id = ?').get(id) as
      | { secret: string }
      | undefined;
    return row ? (JSON.parse(this.keyring.decrypt(row.secret)) as Record<string, string>) : undefined;
  }

  private build(account: Account): MailProvider {
    const secret = this.readSecret(account.id) ?? {};
    let current = secret.refreshToken;
    const rotate = (refreshToken: string) => {
      this.db.transaction(() => {
        if (this.readSecret(account.id)?.refreshToken !== current) return;
        this.db
          .prepare('UPDATE accounts SET secret = ? WHERE id = ?')
          .run(this.keyring.encrypt(JSON.stringify({ refreshToken })), account.id);
      })();
      current = refreshToken;
    };
    switch (account.provider) {
      case 'imap':
        return new ImapProvider(account.config as unknown as ImapConfig, secret.password as string);
      case 'gmail':
        return new GmailProvider(
          new RefreshingToken(googleClient(this.config), secret.refreshToken as string, rotate),
        );
      case 'graph':
        return new GraphProvider(
          new RefreshingToken(microsoftClient(this.config), secret.refreshToken as string, rotate),
        );
    }
  }
}
