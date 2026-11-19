import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraphRequest, GraphProvider } from '../src/providers/graph.js';
import { RefreshingToken } from '../src/providers/oauth.js';
import { mockFetch, tokenRoute } from './fetch-mock.js';

const provider = () =>
  new GraphProvider(
    new RefreshingToken(
      {
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        clientId: 'c',
        clientSecret: 's',
      },
      'refresh',
      () => undefined,
    ),
  );

const msg = (id: string, receivedDateTime: string) => ({
  id,
  conversationId: `conv-${id}`,
  subject: `S ${id}`,
  from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
  toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
  receivedDateTime,
  bodyPreview: 'preview',
  isRead: false,
  hasAttachments: false,
});

afterEach(() => vi.unstubAllGlobals());

describe('buildGraphRequest', () => {
  it('uses $search KQL for text filters', () => {
    const url = new URL(
      buildGraphRequest({ from: 'alice', subject: 'q3 plan', since: new Date('2026-11-01') }, 10),
    );
    expect(url.pathname).toBe('/v1.0/me/messages');
    expect(url.searchParams.get('$search')).toBe(
      '"from:alice AND subject:q3 AND subject:plan AND received>=2026-11-01"',
    );
    expect(url.searchParams.get('$orderby')).toBeNull();
  });

  it('uses $filter with a leading receivedDateTime clause otherwise', () => {
    const url = new URL(buildGraphRequest({ unread: true, folder: 'inbox' }, 5));
    expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
    expect(url.searchParams.get('$filter')).toBe(
      'receivedDateTime ge 1970-01-01T00:00:00.000Z and isRead eq false',
    );
    expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
  });

  it('keeps the whole day of a before datetime, supports hasAttachment: false and keeps rawQuery phrases', () => {
    const url = new URL(
      buildGraphRequest(
        {
          text: 'invoice',
          before: new Date('2026-11-19T15:00:00Z'),
          hasAttachment: false,
          rawQuery: 'from:"Smith, John"',
        },
        10,
      ),
    );
    expect(url.searchParams.get('$search')).toBe(
      '"invoice AND from:\\"Smith, John\\" AND received<2026-11-20 AND hasAttachments:false"',
    );
    const midnight = new URL(buildGraphRequest({ text: 'x', before: new Date('2026-11-19T00:00:00Z') }, 10));
    expect(midnight.searchParams.get('$search')).toBe('"x AND received<2026-11-19"');
  });
});

describe('GraphProvider.changesSince', () => {
  it('advances to the newest receivedDateTime and skips boundary messages already seen', async () => {
    let filter = '';
    mockFetch([
      tokenRoute(/oauth2\/v2\.0\/token/),
      [
        /mailFolders\/inbox\/messages/,
        (url) => {
          filter = url.searchParams.get('$filter') ?? '';
          return {
            value: [
              msg('a', '2026-11-18T10:00:00Z'),
              msg('b', '2026-11-18T11:00:00Z'),
              msg('c', '2026-11-18T11:00:00Z'),
            ],
          };
        },
      ],
    ]);
    const changes = await provider().changesSince({ at: '2026-11-18T10:00:00Z', seen: ['a'] }, 50);
    expect(filter).toBe('receivedDateTime ge 2026-11-18T10:00:00Z');
    expect(changes.messages.map((m) => m.providerId)).toEqual(['c', 'b']);
    expect(changes.checkpoint).toEqual({ at: '2026-11-18T11:00:00Z', seen: ['b', 'c'] });
  });

  it('keeps earlier boundary ids when new mail shares the checkpoint second', async () => {
    mockFetch([
      tokenRoute(/oauth2\/v2\.0\/token/),
      [
        /mailFolders\/inbox\/messages/,
        () => ({ value: [msg('a', '2026-11-18T10:00:00Z'), msg('b', '2026-11-18T10:00:00Z')] }),
      ],
    ]);
    const changes = await provider().changesSince({ at: '2026-11-18T10:00:00Z', seen: ['a'] }, 50);
    expect(changes.messages.map((m) => m.providerId)).toEqual(['b']);
    expect(changes.checkpoint).toEqual({ at: '2026-11-18T10:00:00Z', seen: ['a', 'b'] });
  });

  it('delivers the oldest messages first and checkpoints at the last delivered one when truncated', async () => {
    mockFetch([
      tokenRoute(/oauth2\/v2\.0\/token/),
      [
        /mailFolders\/inbox\/messages/,
        () => ({
          value: [
            msg('a', '2026-11-18T10:00:00Z'),
            msg('b', '2026-11-18T11:00:00Z'),
            msg('c', '2026-11-18T12:00:00Z'),
          ],
        }),
      ],
    ]);
    const changes = await provider().changesSince({ at: '2026-11-18T09:00:00Z', seen: [] }, 2);
    expect(changes.messages.map((m) => m.providerId)).toEqual(['b', 'a']);
    expect(changes.checkpoint).toEqual({ at: '2026-11-18T11:00:00Z', seen: ['b'] });
    expect(changes.truncated).toBe(true);
  });

  it('lists nested folders with their full path', async () => {
    mockFetch([
      tokenRoute(/oauth2\/v2\.0\/token/),
      [
        /mailFolders\/inbox-id\/childFolders/,
        () => ({ value: [{ id: 'projects-id', displayName: 'Projects', childFolderCount: 0 }] }),
      ],
      [
        /mailFolders\?/,
        () => ({
          value: [{ id: 'inbox-id', displayName: 'Inbox', childFolderCount: 1, unreadItemCount: 3 }],
        }),
      ],
    ]);
    expect(await provider().listFolders()).toEqual([
      { id: 'inbox-id', name: 'Inbox', total: undefined, unread: 3 },
      { id: 'projects-id', name: 'Inbox/Projects', total: undefined, unread: undefined },
    ]);
  });

  it('rejects cursors that point outside Graph', async () => {
    mockFetch([tokenRoute(/oauth2\/v2\.0\/token/)]);
    await expect(provider().search({}, 10, 'https://evil.example/steal')).rejects.toThrow('Invalid cursor');
  });
});
