import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type AppOptions, createApp } from '../src/app.js';
import { SESSION_COOKIE, upsertUser } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';
import { generateKey, Keyring, randomToken, sha256 } from '../src/crypto.js';
import { type DB, now, openDb } from '../src/db.js';

export const OWNER = 'owner@example.com';

export interface TestServer {
  url: string;
  mcpUrl: string;
  db: DB;
  server: Server;
  app: ReturnType<typeof createApp>;
  keyring: Keyring;
  close(): Promise<void>;
}

export async function startServer(options: AppOptions = {}): Promise<TestServer> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://localhost:${port}`;
  const config = loadConfig({
    PUBLIC_URL: url,
    DATABASE_PATH: ':memory:',
    INBOXMUX_ENCRYPTION_KEY: `k1:${generateKey()}`,
    OWNER_EMAILS: OWNER,
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
  });
  const db = openDb(':memory:');
  const keyring = new Keyring(config.INBOXMUX_ENCRYPTION_KEY);
  const app = createApp(db, config, keyring, options);
  server.on('request', app.app);
  return {
    url,
    mcpUrl: `${url}/mcp`,
    db,
    server,
    app,
    keyring,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function ownerSession(db: DB, email = OWNER): { cookie: string; userId: number } {
  const userId = upsertUser(db, email);
  const id = randomToken();
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(id),
    userId,
    'csrf-token',
    now() + 3600,
  );
  return { cookie: `${SESSION_COOKIE}=${id}`, userId };
}

export const REDIRECT_URI = 'http://localhost:9999/callback';

export async function registerClient(t: TestServer): Promise<string> {
  const res = await fetch(`${t.url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export async function authorize(t: TestServer, clientId: string, cookie: string) {
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: t.mcpUrl,
  });
  const start = await fetch(`${t.url}/authorize?${params}`, { redirect: 'manual' });
  const consentPath = start.headers.get('location');
  if (start.status !== 302 || !consentPath?.startsWith('/consent/')) {
    throw new Error(`authorize did not redirect to consent: ${start.status} ${await start.text()}`);
  }
  const page = await fetch(`${t.url}${consentPath}`, { headers: { cookie } });
  const html = await page.text();
  const approve = await fetch(`${t.url}${consentPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'csrf-token', decision: 'approve' }),
  });
  const callback = new URL(approve.headers.get('location') ?? '');
  return { html, callback, verifier };
}

export async function tokenRequest(t: TestServer, body: Record<string, string>) {
  const res = await fetch(`${t.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

export async function connectedToken(
  t: TestServer,
): Promise<{ accessToken: string; refreshToken: string; clientId: string; userId: number }> {
  const { cookie, userId } = ownerSession(t.db);
  const clientId = await registerClient(t);
  const { callback, verifier } = await authorize(t, clientId, cookie);
  const { body } = await tokenRequest(t, {
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code') ?? '',
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    resource: t.mcpUrl,
  });
  return { accessToken: body.access_token ?? '', refreshToken: body.refresh_token ?? '', clientId, userId };
}

export async function mcpClient(t: TestServer, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(t.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

export function textOf(result: unknown): string[] {
  return ((result as { content: Array<{ type: string; text: string }> }).content ?? []).map((c) => c.text);
}
