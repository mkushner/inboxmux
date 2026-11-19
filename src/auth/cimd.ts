import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
  type OAuthClientInformationFull,
  OAuthClientMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const MAX_BYTES = 16_384;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/' && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    const isBlocked = mapped
      ? blocked.check(mapped, 'ipv4')
      : blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
    if (isBlocked) {
      throw new Error(`Client metadata host ${hostname} resolves to a non-public address`);
    }
  }
}

export async function fetchClientMetadata(clientId: string): Promise<OAuthClientInformationFull> {
  const url = new URL(clientId);
  await assertPublicHost(url.hostname);
  const res = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok || !res.body) throw new Error(`Client metadata fetch failed: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body.cancel();
    throw new Error('Client metadata document is too large');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('Client metadata document is too large');
    chunks.push(chunk);
  }
  const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  if (doc.client_id !== clientId) throw new Error('client_id in metadata document does not match its URL');
  const metadata = OAuthClientMetadataSchema.parse(doc);
  const method = metadata.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') throw new Error(`Unsupported token_endpoint_auth_method "${method}"`);
  return { ...metadata, client_id: clientId, token_endpoint_auth_method: 'none' };
}
