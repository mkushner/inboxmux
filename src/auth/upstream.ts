import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { Config } from '../config.js';
import { randomToken } from '../crypto.js';
import { type DB, putPending, takePending } from '../db.js';
import { GMAIL_SCOPE } from '../providers/gmail.js';
import { GRAPH_SCOPE } from '../providers/graph.js';
import { type OAuthClientConfig, postToken, type TokenResponse } from '../providers/oauth.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const STATE_TTL = 600;

export type UpstreamFlow =
  | { kind: 'login'; next: string }
  | { kind: 'gmail'; userId: number; alias: string; accountId?: number }
  | { kind: 'graph'; userId: number; alias: string; accountId?: number };

type Stored = UpstreamFlow & { verifier: string; nonce: string };

export const googleClient = (config: Config): OAuthClientConfig => ({
  tokenUrl: GOOGLE_TOKEN_URL,
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
});

export function microsoftClient(config: Config): OAuthClientConfig {
  if (!config.MICROSOFT_CLIENT_ID || !config.MICROSOFT_CLIENT_SECRET) {
    throw new Error('Microsoft accounts need MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET');
  }
  return {
    tokenUrl: `https://login.microsoftonline.com/${config.MICROSOFT_TENANT}/oauth2/v2.0/token`,
    clientId: config.MICROSOFT_CLIENT_ID,
    clientSecret: config.MICROSOFT_CLIENT_SECRET,
    scope: GRAPH_SCOPE,
  };
}

export const googleRedirectUri = (config: Config) => `${config.PUBLIC_URL}/oauth/google/callback`;
export const microsoftRedirectUri = (config: Config) => `${config.PUBLIC_URL}/oauth/microsoft/callback`;

function begin(db: DB, flow: UpstreamFlow) {
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  putPending(db, state, 'upstream', { ...flow, verifier, nonce } satisfies Stored, STATE_TTL);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, nonce, challenge };
}

export function redirectToGoogle(
  db: DB,
  config: Config,
  res: Response,
  flow: UpstreamFlow,
  loginHint?: string,
) {
  const { state, nonce, challenge } = begin(db, flow);
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(config),
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (flow.kind === 'login') {
    params.set('scope', 'openid email');
    params.set('nonce', nonce);
    params.set('prompt', 'select_account');
  } else {
    params.set('scope', GMAIL_SCOPE);
    params.set('access_type', 'offline');
    params.set('prompt', 'consent select_account');
  }
  if (loginHint) params.set('login_hint', loginHint);
  res.redirect(302, `${GOOGLE_AUTH_URL}?${params}`);
}

export function redirectToMicrosoft(
  db: DB,
  config: Config,
  res: Response,
  flow: UpstreamFlow,
  loginHint?: string,
) {
  const client = microsoftClient(config);
  const { state, challenge } = begin(db, flow);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: microsoftRedirectUri(config),
    response_type: 'code',
    response_mode: 'query',
    scope: GRAPH_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  if (loginHint) params.set('login_hint', loginHint);
  res.redirect(
    302,
    `https://login.microsoftonline.com/${config.MICROSOFT_TENANT}/oauth2/v2.0/authorize?${params}`,
  );
}

export async function completeUpstream(
  db: DB,
  client: OAuthClientConfig,
  redirectUri: string,
  query: Record<string, unknown>,
): Promise<{ flow: UpstreamFlow; nonce: string; tokens: TokenResponse }> {
  const stored =
    typeof query.state === 'string' ? takePending<Stored>(db, query.state, 'upstream') : undefined;
  if (!stored) throw new Error('Sign-in session expired or invalid; start again');
  if (typeof query.error === 'string') throw new Error(`Provider returned an error: ${query.error}`);
  if (typeof query.code !== 'string') throw new Error('Missing authorization code');
  const { verifier, nonce, ...flow } = stored;
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: query.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  if (client.scope) params.scope = client.scope;
  const tokens = await postToken(client, params);
  return { flow: flow as UpstreamFlow, nonce, tokens };
}

// The ID token comes straight from Google's token endpoint over TLS, so its signature
// need not be checked (OpenID Connect Core 3.1.3.7); the claims still are.
export function googleEmailFromIdToken(idToken: string | undefined, config: Config, nonce: string): string {
  const payload = idToken?.split('.')[1];
  if (!payload) throw new Error('Google did not return an ID token');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) throw new Error('Unexpected ID token issuer');
  if (claims.aud !== config.GOOGLE_CLIENT_ID) throw new Error('ID token audience mismatch');
  if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('ID token expired');
  if (claims.email_verified !== true || typeof claims.email !== 'string')
    throw new Error('Email is not verified');
  return claims.email.toLowerCase();
}
