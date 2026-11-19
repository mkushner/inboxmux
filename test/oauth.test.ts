import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_REUSE_GRACE } from '../src/auth/provider.js';
import {
  authorize,
  connectedToken,
  mcpClient,
  OWNER,
  ownerSession,
  REDIRECT_URI,
  registerClient,
  startServer,
  type TestServer,
  textOf,
  tokenRequest,
} from './helpers.js';

const CIMD_ID = 'https://client.example/oauth/metadata.json';

let t: TestServer;
let metadataHostDown = false;

beforeEach(async () => {
  metadataHostDown = false;
  t = await startServer({
    fetchClientMetadata: async (clientId) => {
      if (metadataHostDown) throw new Error('unreachable');
      return {
        client_id: clientId,
        client_name: 'Metadata Client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      };
    },
  });
});

afterEach(async () => {
  await t.close();
});

describe('discovery', () => {
  it('advertises protected resource and authorization server metadata', async () => {
    const prm = await (await fetch(`${t.url}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe(t.mcpUrl);
    const as = await (await fetch(`${t.url}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe(`${t.url}/register`);
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  it('rejects unauthenticated MCP requests with a resource metadata pointer', async () => {
    const res = await fetch(t.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
  });
});

describe('authorization code flow', () => {
  it('issues tokens that work against the MCP endpoint', async () => {
    const { accessToken } = await connectedToken(t);
    const client = await mcpClient(t, accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual([
      'ack_changes',
      'get_changes',
      'get_message',
      'get_thread',
      'list_accounts',
      'list_folders',
      'search_messages',
    ]);
    expect(tools.tools.every((x) => x.annotations?.readOnlyHint === true)).toBe(true);
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(JSON.parse(textOf(result)[0] as string)).toEqual({ accounts: [] });
    const audit = t.db.prepare('SELECT tool FROM audit_log').all();
    expect(audit).toEqual([{ tool: 'list_accounts' }]);
    await client.close();
  });

  it('sends the owner to sign in before consent', async () => {
    const clientId = await registerClient(t);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
    const start = await fetch(`${t.url}/authorize?${params}`, { redirect: 'manual' });
    const consent = await fetch(`${t.url}${start.headers.get('location')}`, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    expect(consent.headers.get('location')).toMatch(/^\/login\?next=%2Fconsent%2F/);
  });

  it('rejects unregistered redirect URIs and foreign resources', async () => {
    const clientId = await registerClient(t);
    const base = {
      response_type: 'code',
      client_id: clientId,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    };
    const bad = await fetch(
      `${t.url}/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://evil.example/cb' })}`,
      { redirect: 'manual' },
    );
    expect(bad.status).toBe(400);
    const foreign = await fetch(
      `${t.url}/authorize?${new URLSearchParams({ ...base, redirect_uri: REDIRECT_URI, resource: 'https://other.example/mcp' })}`,
      { redirect: 'manual' },
    );
    expect(new URL(foreign.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
  });

  it('requires a CSRF token to approve', async () => {
    const { cookie } = ownerSession(t.db);
    const clientId = await registerClient(t);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
    const start = await fetch(`${t.url}/authorize?${params}`, { redirect: 'manual' });
    const res = await fetch(`${t.url}${start.headers.get('location')}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'approve' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a wrong PKCE verifier and single-use codes', async () => {
    const { cookie } = ownerSession(t.db);
    const clientId = await registerClient(t);
    const { callback, verifier } = await authorize(t, clientId, cookie);
    const code = callback.searchParams.get('code') ?? '';
    expect(callback.searchParams.get('state')).toBe('state-1');
    const base = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT_URI };
    expect((await tokenRequest(t, { ...base, code_verifier: 'wrong'.repeat(10) })).body.error).toBe(
      'invalid_grant',
    );
    expect((await tokenRequest(t, { ...base, code_verifier: verifier })).status).toBe(200);
    expect((await tokenRequest(t, { ...base, code_verifier: verifier })).body.error).toBe('invalid_grant');
  });

  it('accepts Client ID Metadata Document clients', async () => {
    const { cookie } = ownerSession(t.db);
    const { html, callback } = await authorize(t, CIMD_ID, cookie);
    expect(html).toContain('Metadata Client');
    expect(callback.searchParams.get('code')).toBeTruthy();
  });

  it('keeps using cached client metadata when a refresh of it fails', async () => {
    const { cookie } = ownerSession(t.db);
    await authorize(t, CIMD_ID, cookie);
    t.db.prepare('UPDATE oauth_clients SET fetched_at = 0').run();
    metadataHostDown = true;
    const { callback } = await authorize(t, CIMD_ID, cookie);
    expect(callback.searchParams.get('code')).toBeTruthy();
  });

  it('does not expire secrets of confidential DCR clients', async () => {
    const res = await fetch(`${t.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Confidential', redirect_uris: [REDIRECT_URI] }),
    });
    const client = (await res.json()) as {
      client_secret?: string;
      client_secret_expires_at?: number;
      token_endpoint_auth_method?: string;
    };
    expect(client.client_secret).toBeTruthy();
    expect(client.client_secret_expires_at).toBe(0);
    expect(client.token_endpoint_auth_method).toBe('client_secret_post');
  });

  it('rejects client authentication methods the token endpoint cannot verify', async () => {
    const res = await fetch(`${t.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
  });

  it('only returns to same-origin paths after sign-in', async () => {
    for (const next of ['/%5Cevil.example', '//evil.example', 'https://evil.example/']) {
      await fetch(`${t.url}/login?next=${next}`, { redirect: 'manual' });
    }
    await fetch(`${t.url}/login?next=${encodeURIComponent('/admin?x=1')}`, { redirect: 'manual' });
    const stored = t.db
      .prepare("SELECT data FROM pending WHERE kind = 'upstream' ORDER BY rowid")
      .all()
      .map((r) => JSON.parse((r as { data: string }).data).next);
    expect(stored).toEqual(['/admin', '/admin', '/admin', '/admin?x=1']);
  });

  it('stops honouring tokens once the user is removed from OWNER_EMAILS', async () => {
    const { accessToken } = await connectedToken(t);
    t.db.prepare('UPDATE users SET email = ? WHERE email = ?').run('former@example.com', OWNER);
    const res = await fetch(t.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotate, tolerate a retry within the grace window, and revoke the family on later reuse', async () => {
    const { refreshToken, clientId } = await connectedToken(t);
    const refresh = (token: string) =>
      tokenRequest(t, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId });

    const first = await refresh(refreshToken);
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(refreshToken);

    const retry = await refresh(refreshToken);
    expect(retry.status).toBe(200);

    t.db
      .prepare('UPDATE tokens SET rotated_at = rotated_at - ? WHERE rotated_at IS NOT NULL')
      .run(REFRESH_REUSE_GRACE + 1);
    const reuse = await refresh(refreshToken);
    expect(reuse.body.error).toBe('invalid_grant');

    const afterRevoke = await refresh(first.body.refresh_token as string);
    expect(afterRevoke.body.error).toBe('invalid_grant');
    const live = t.db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number };
    expect(live.n).toBe(0);
  });
});

describe('connected clients', () => {
  it('lists each grant once and revokes it from the admin page', async () => {
    const { accessToken, refreshToken, clientId, userId } = await connectedToken(t);
    await tokenRequest(t, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    await tokenRequest(t, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    const grants = t.app.auth.listGrants(userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ clientId, clientName: 'Test Client', redirectUris: [REDIRECT_URI] });

    const { cookie } = ownerSession(t.db);
    const page = await (await fetch(`${t.url}/admin`, { headers: { cookie } })).text();
    expect(page).toContain('Test Client');
    const revoke = await fetch(`${t.url}/admin/grants/${grants[0]?.familyId}/revoke`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'csrf-token' }),
    });
    expect(revoke.status).toBe(303);
    expect(t.app.auth.listGrants(userId)).toHaveLength(0);
    const res = await fetch(t.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('ALLOWED_REDIRECT_ORIGINS', () => {
  it('rejects registrations and metadata documents that redirect elsewhere, allowing loopback on any port', async () => {
    const restricted = await startServer(
      {
        fetchClientMetadata: async (clientId) => ({
          client_id: clientId,
          redirect_uris: ['https://evil.example/cb'],
          token_endpoint_auth_method: 'none',
        }),
      },
      { ALLOWED_REDIRECT_ORIGINS: 'https://claude.ai,http://localhost' },
    );
    try {
      const register = (redirect: string) =>
        fetch(`${restricted.url}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
        });
      expect((await register('https://evil.example/cb')).status).toBe(400);
      expect((await register('https://claude.ai/api/mcp/auth_callback')).status).toBe(201);
      expect((await register('http://localhost:53682/callback')).status).toBe(201);

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CIMD_ID,
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      });
      const authorize = await fetch(`${restricted.url}/authorize?${params}`, { redirect: 'manual' });
      expect(authorize.status).toBe(400);
    } finally {
      await restricted.close();
    }
  });
});
