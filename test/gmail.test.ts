import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/mail/types.js';
import { buildGmailQuery, GmailProvider } from '../src/providers/gmail.js';
import { RefreshingToken } from '../src/providers/oauth.js';
import { mockFetch, tokenRoute } from './fetch-mock.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function provider() {
  return new GmailProvider(
    new RefreshingToken(
      { tokenUrl: TOKEN_URL, clientId: 'c', clientSecret: 's' },
      'refresh',
      () => undefined,
    ),
  );
}

const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Hi &amp; welcome',
  internalDate: String(Date.parse('2026-11-18T10:00:00Z') + Number(id.replace(/\D/g, '')) * 1000),
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'me@example.com, "Doe, J" <j@example.com>' },
      { name: 'Subject', value: `Subject ${id}` },
    ],
  },
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('buildGmailQuery', () => {
  it('maps structured filters to Gmail search syntax', () => {
    const q = buildGmailQuery({
      from: 'alice@example.com',
      subject: 'q3 (draft)',
      since: new Date('2026-11-01T00:00:00Z'),
      unread: true,
      hasAttachment: true,
      excludeAutomated: true,
      rawQuery: 'label:work',
    });
    expect(q).toBe(
      'from:(alice@example.com) subject:(q3  draft ) after:1793491200 is:unread has:attachment ' +
        '-category:promotions -category:social -category:updates -category:forums label:work',
    );
  });
});

describe('GmailProvider', () => {
  it('searches and returns compact summaries', async () => {
    const calls = mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [/\/messages\?/, () => ({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'next' })],
      [/\/messages\/(m\d)\?format=metadata/, (url) => meta(url.pathname.split('/').pop() as string)],
    ]);
    const page = await provider().search({ from: 'alice' }, 2);
    expect(page.nextCursor).toBe('next');
    expect(page.messages.map((m) => m.providerId)).toEqual(['m2', 'm1']);
    expect(page.messages[0]).toMatchObject({
      from: 'Alice <alice@example.com>',
      to: ['me@example.com', '"Doe, J" <j@example.com>'],
      snippet: 'Hi & welcome',
      unread: true,
      automated: false,
    });
    expect(calls.find((u) => u.pathname.endsWith('/messages'))?.searchParams.get('q')).toBe('from:(alice)');
  });

  it('first get_changes returns the last day of inbox mail and stores the profile historyId', async () => {
    const calls = mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [/\/profile$/, () => ({ emailAddress: 'me@example.com', historyId: '900' })],
      [/\/messages\?/, () => ({ messages: [{ id: 'm1' }] })],
      [/\/messages\/m1\?/, () => meta('m1')],
    ]);
    const changes = await provider().changesSince(undefined, 50);
    expect(changes.messages).toHaveLength(1);
    expect(changes.checkpoint).toMatchObject({ historyId: '900' });
    expect(calls.find((u) => u.pathname.endsWith('/messages'))?.searchParams.get('q')).toMatch(
      /^in:inbox after:\d+$/,
    );
  });

  it('later calls use history and keep only messages added to INBOX', async () => {
    mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [
        /\/history\?/,
        () => ({
          historyId: '950',
          history: [
            { id: '901', messagesAdded: [{ message: { id: 'm3', labelIds: ['INBOX'] } }] },
            { id: '902', messagesAdded: [{ message: { id: 'm4', labelIds: ['SENT'] } }] },
            { id: '903', labelsAdded: [{ message: { id: 'm5' }, labelIds: ['INBOX'] }] },
            { id: '904', messagesAdded: [{ message: { id: 'm6', threadId: 't6' } }] },
          ],
        }),
      ],
      [/\/messages\/(m\d)\?/, (url) => meta(url.pathname.split('/').pop() as string)],
    ]);
    const changes = await provider().changesSince({ historyId: '900', at: 1 }, 50);
    expect(changes.messages.map((m) => m.providerId).sort()).toEqual(['m3', 'm5', 'm6']);
    expect(changes.checkpoint).toMatchObject({ historyId: '950' });
    expect(changes.truncated).toBe(false);
  });

  it('resumes history after the last delivered record when truncated', async () => {
    mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [
        /\/history\?/,
        () => ({
          historyId: '990',
          history: [
            { id: '901', messagesAdded: [{ message: { id: 'm1' } }] },
            { id: '902', messagesAdded: [{ message: { id: 'm2' } }] },
            { id: '903', messagesAdded: [{ message: { id: 'm3' } }] },
          ],
        }),
      ],
      [/\/messages\/(m\d)\?/, (url) => meta(url.pathname.split('/').pop() as string)],
    ]);
    const changes = await provider().changesSince({ historyId: '900', at: 1 }, 2);
    expect(changes.messages.map((m) => m.providerId).sort()).toEqual(['m1', 'm2']);
    expect(changes.checkpoint).toMatchObject({ historyId: '902' });
    expect(changes.truncated).toBe(true);
  });

  it('delivers the oldest messages first and resumes by time when the time window is truncated', async () => {
    mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [/\/profile$/, () => ({ emailAddress: 'me@example.com', historyId: '900' })],
      [/\/messages\?/, () => ({ messages: [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }] })],
      [/\/messages\/(m\d)\?/, (url) => meta(url.pathname.split('/').pop() as string)],
    ]);
    const changes = await provider().changesSince(undefined, 2);
    expect(changes.messages.map((m) => m.providerId).sort()).toEqual(['m1', 'm2']);
    expect(changes.truncated).toBe(true);
    expect(changes.checkpoint).toEqual({
      at: Math.floor(Date.parse('2026-11-18T10:00:02Z') / 1000) - 1,
      seen: ['m2', 'm1'],
    });
  });

  it('makes progress when more than limit messages share one second', async () => {
    const sameSecond = String(Date.parse('2026-11-18T10:00:00Z'));
    mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [/\/profile$/, () => ({ emailAddress: 'me@example.com', historyId: '900' })],
      [/\/messages\?/, () => ({ messages: [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }] })],
      [
        /\/messages\/(m\d)\?/,
        (url) => meta(url.pathname.split('/').pop() as string, { internalDate: sameSecond }),
      ],
    ]);
    const first = await provider().changesSince(undefined, 2);
    const second = await provider().changesSince(first.checkpoint, 2);
    const delivered = [...first.messages, ...second.messages].map((m) => m.providerId).sort();
    expect(delivered).toEqual(['m1', 'm2', 'm3']);
    expect(second.truncated).toBeUndefined();
    expect(second.checkpoint).toMatchObject({ historyId: '900' });
  });

  it('falls back to a time-based search when the historyId has expired', async () => {
    mockFetch([
      tokenRoute(/oauth2\.googleapis\.com\/token/),
      [/\/history\?/, () => new Response('{}', { status: 404 })],
      [/\/profile$/, () => ({ emailAddress: 'me@example.com', historyId: '1000' })],
      [
        /\/messages\?/,
        (url) => ({
          messages: url.searchParams.get('q') === 'in:inbox after:1700000000' ? [{ id: 'm1' }] : [],
        }),
      ],
      [/\/messages\/m1\?/, () => meta('m1')],
    ]);
    const changes = await provider().changesSince({ historyId: '1', at: 1_700_000_000 }, 50);
    expect(changes.messages).toHaveLength(1);
    expect(changes.checkpoint).toMatchObject({ historyId: '1000' });
  });

  it('turns a rejected refresh token into an AuthError', async () => {
    mockFetch([
      [/oauth2\.googleapis\.com\/token/, () => Response.json({ error: 'invalid_grant' }, { status: 400 })],
    ]);
    await expect(provider().listFolders()).rejects.toBeInstanceOf(AuthError);
  });
});
