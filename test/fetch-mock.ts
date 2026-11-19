import { vi } from 'vitest';

type Handler = (url: URL, init?: RequestInit) => unknown;

export function mockFetch(routes: Array<[RegExp, Handler]>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes.find(([re]) => re.test(url.href));
    if (!route) return new Response('not mocked', { status: 500 });
    const out = route[1](url, init);
    if (out instanceof Response) return out;
    if (typeof out === 'string') return new Response(out);
    return Response.json(out);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export const tokenRoute = (re: RegExp): [RegExp, Handler] => [
  re,
  () => ({ access_token: 'access', expires_in: 3600 }),
];
