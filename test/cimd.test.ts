import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchClientMetadata, isCimdClientId } from '../src/auth/cimd.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchClientMetadata', () => {
  it('refuses non-public hosts before fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '[::1]', '[::ffff:127.0.0.1]']) {
      await expect(fetchClientMetadata(`https://${host}/client.json`)).rejects.toThrow(/non-public/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops reading a body that exceeds the size limit', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(8192));
      },
    });
    vi.stubGlobal('fetch', async () => new Response(endless));
    await expect(fetchClientMetadata('https://93.184.215.14/client.json')).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThan(10);
  });

  it('requires client_id to match the document URL', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ client_id: 'https://other.example/c.json', redirect_uris: ['https://x.example/cb'] }),
    );
    await expect(fetchClientMetadata('https://93.184.215.14/client.json')).rejects.toThrow(/does not match/);
  });
});

describe('isCimdClientId', () => {
  it('accepts only https URLs with a path', () => {
    expect(isCimdClientId('https://client.example/meta.json')).toBe(true);
    expect(isCimdClientId('https://client.example/')).toBe(false);
    expect(isCimdClientId('http://client.example/meta.json')).toBe(false);
    expect(isCimdClientId('3f2c1b2a-uuid')).toBe(false);
  });
});
