import { AuthError } from '../mail/types.js';

export interface OAuthClientConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export async function postToken(
  client: OAuthClientConfig,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(client.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    const reason = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    if (body.error === 'invalid_grant' || body.error === 'unauthorized_client') {
      throw new AuthError(`Token refresh rejected: ${reason}`);
    }
    throw new Error(`Token endpoint error: ${reason}`);
  }
  return body as TokenResponse;
}

export class RefreshingToken {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly client: OAuthClientConfig,
    private refreshToken: string,
    private readonly onRotate: (refreshToken: string) => void,
  ) {}

  async get(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token;
    const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: this.refreshToken };
    if (this.client.scope) params.scope = this.client.scope;
    const res = await postToken(this.client, params);
    if (res.refresh_token && res.refresh_token !== this.refreshToken) {
      this.refreshToken = res.refresh_token;
      this.onRotate(res.refresh_token);
    }
    this.cached = { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return res.access_token;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function authedJson<T>(token: RefreshingToken, url: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(token, url, init);
  return (await res.json()) as T;
}

export async function authedFetch(
  token: RefreshingToken,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let res = await send(await token.get());
  if (res.status === 401) res = await send(await token.get(true));
  if (res.status === 401) throw new AuthError('Access token rejected by the provider');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
  }
  return res;

  function send(accessToken: string) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
