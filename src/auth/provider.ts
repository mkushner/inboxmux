import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { randomToken, sha256 } from '../crypto.js';
import { type DB, now, putPending } from '../db.js';
import { fetchClientMetadata, isCimdClientId } from './cimd.js';

export const SCOPE = 'mail.read';
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 86_400;
const CODE_TTL = 300;
const AUTHORIZE_TTL = 600;
const CIMD_CACHE_TTL = 86_400;
export const REFRESH_REUSE_GRACE = 120;
const SUPPORTED_AUTH_METHODS = ['none', 'client_secret_post'];

export interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
}

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  family_id: string;
  client_id: string;
  user_id: number;
  scopes: string;
  resource: string;
  expires_at: number;
  rotated_at: number | null;
}

export class InboxmuxAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly db: DB,
    private readonly mcpUrl: string,
    private readonly ownerEmails: string[],
    private readonly fetchMetadata = fetchClientMetadata,
  ) {
    this.clientsStore = {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => {
        const method = client.token_endpoint_auth_method;
        if (method !== undefined && !SUPPORTED_AUTH_METHODS.includes(method)) {
          throw new InvalidClientMetadataError(
            `token_endpoint_auth_method must be one of: ${SUPPORTED_AUTH_METHODS.join(', ')}`,
          );
        }
        const full = {
          ...client,
          token_endpoint_auth_method: method ?? 'client_secret_post',
        } as OAuthClientInformationFull;
        db.prepare(
          "INSERT INTO oauth_clients (client_id, metadata, source, fetched_at) VALUES (?, ?, 'dcr', ?)",
        ).run(full.client_id, JSON.stringify(full), now());
        return full;
      },
    };
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = this.db
      .prepare('SELECT metadata, source, fetched_at FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as { metadata: string; source: string; fetched_at: number } | undefined;
    if (row && (row.source === 'dcr' || row.fetched_at > now() - CIMD_CACHE_TTL)) {
      return JSON.parse(row.metadata) as OAuthClientInformationFull;
    }
    if (!isCimdClientId(clientId)) return undefined;
    try {
      const metadata = await this.fetchMetadata(clientId);
      this.db
        .prepare(
          `INSERT INTO oauth_clients (client_id, metadata, source, fetched_at) VALUES (?, ?, 'cimd', ?)
           ON CONFLICT (client_id) DO UPDATE SET metadata = excluded.metadata, fetched_at = excluded.fetched_at`,
        )
        .run(clientId, JSON.stringify(metadata), now());
      return metadata;
    } catch {
      return row ? (JSON.parse(row.metadata) as OAuthClientInformationFull) : undefined;
    }
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const resource = params.resource ? params.resource.href.replace(/\/$/, '') : this.mcpUrl;
    if (resource !== this.mcpUrl) throw new InvalidTargetError(`Unknown resource ${resource}`);
    const id = randomToken();
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: [SCOPE],
      resource,
    };
    putPending(this.db, id, 'authorize', pending, AUTHORIZE_TTL);
    res.redirect(302, `/consent/${id}`);
  }

  issueCode(pending: PendingAuthorization, userId: number): string {
    const code = randomToken('imx_code_');
    this.db
      .prepare(
        `INSERT INTO auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha256(code),
        pending.clientId,
        userId,
        pending.redirectUri,
        pending.codeChallenge,
        pending.scopes.join(' '),
        pending.resource,
        now() + CODE_TTL,
      );
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.db
      .prepare(
        'SELECT code_challenge FROM auth_codes WHERE code_hash = ? AND client_id = ? AND expires_at >= ?',
      )
      .get(sha256(code), client.client_id, now()) as { code_challenge: string } | undefined;
    if (!row) throw new InvalidGrantError('Invalid or expired authorization code');
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.db.prepare('DELETE FROM auth_codes WHERE code_hash = ? RETURNING *').get(sha256(code)) as
      | {
          client_id: string;
          user_id: number;
          redirect_uri: string;
          scopes: string;
          resource: string;
          expires_at: number;
        }
      | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource && resource.href.replace(/\/$/, '') !== row.resource) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }
    return this.issueTokens(randomToken(), row.client_id, row.user_id, row.scopes, row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const result = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(sha256(refreshToken)) as TokenRow | undefined;
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        return new InvalidGrantError('Invalid or expired refresh token');
      }
      if (resource && resource.href.replace(/\/$/, '') !== row.resource) {
        return new InvalidTargetError('resource does not match the original grant');
      }
      if (row.rotated_at !== null && now() - row.rotated_at > REFRESH_REUSE_GRACE) {
        this.db.prepare('DELETE FROM tokens WHERE family_id = ?').run(row.family_id);
        return new InvalidGrantError('Refresh token reuse detected; the grant has been revoked');
      }
      if (!this.isOwner(row.user_id)) return new InvalidGrantError('User is no longer allowed');
      if (row.rotated_at === null) {
        this.db.prepare('UPDATE tokens SET rotated_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
      }
      return this.issueTokens(row.family_id, row.client_id, row.user_id, row.scopes, row.resource);
    })();
    if (result instanceof Error) throw result;
    return result;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'access'")
      .get(sha256(token)) as TokenRow | undefined;
    if (!row || row.expires_at < now() || !this.isOwner(row.user_id)) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' '),
      expiresAt: row.expires_at,
      resource: new URL(row.resource),
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.db
      .prepare('SELECT family_id, client_id FROM tokens WHERE token_hash = ?')
      .get(sha256(request.token)) as { family_id: string; client_id: string } | undefined;
    if (row && row.client_id === client.client_id) {
      this.db.prepare('DELETE FROM tokens WHERE family_id = ?').run(row.family_id);
    }
  }

  private isOwner(userId: number): boolean {
    const user = this.db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as
      | { email: string }
      | undefined;
    return Boolean(user && this.ownerEmails.includes(user.email));
  }

  private issueTokens(familyId: string, clientId: string, userId: number, scopes: string, resource: string) {
    const access = randomToken('imx_at_');
    const refresh = randomToken('imx_rt_');
    const insert = this.db.prepare(
      `INSERT INTO tokens (token_hash, kind, family_id, client_id, user_id, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(sha256(access), 'access', familyId, clientId, userId, scopes, resource, now() + ACCESS_TTL);
    insert.run(sha256(refresh), 'refresh', familyId, clientId, userId, scopes, resource, now() + REFRESH_TTL);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
      scope: scopes,
    };
  }
}
