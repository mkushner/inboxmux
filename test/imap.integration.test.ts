import { ImapFlow } from 'imapflow';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, UserError } from '../src/mail/types.js';
import { type ImapConfig, ImapProvider } from '../src/providers/imap.js';

const config: ImapConfig = {
  host: process.env.IMAP_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.IMAP_TEST_PORT ?? 3143),
  secure: false,
  user: 'test@example.com',
};
const PASSWORD = 'secret';

function message(opts: {
  id: string;
  subject: string;
  from: string;
  body: string;
  refs?: string;
  extra?: string;
}) {
  return [
    `From: ${opts.from}`,
    'To: test@example.com',
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.id}@example.com>`,
    `Date: ${new Date().toUTCString()}`,
    ...(opts.refs
      ? [`In-Reply-To: <${opts.refs}@example.com>`, `References: <${opts.refs}@example.com>`]
      : []),
    ...(opts.extra ? [opts.extra] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body,
    '',
  ].join('\r\n');
}

async function append(raw: string, flags: string[] = []) {
  const client = new ImapFlow({ ...config, auth: { user: config.user, pass: PASSWORD }, logger: false });
  await client.connect();
  await client.append('INBOX', raw, flags);
  await client.logout();
}

describe.skipIf(!process.env.IMAP_TEST)('ImapProvider against GreenMail', () => {
  const provider = new ImapProvider(config, PASSWORD);
  const tag = Date.now().toString(36);

  beforeAll(async () => {
    await append(
      message({
        id: `root-${tag}`,
        subject: `Plan ${tag}`,
        from: 'Alice <alice@example.com>',
        body: 'First draft',
      }),
    );
    await append(
      message({
        id: `reply-${tag}`,
        subject: `Re: Plan ${tag}`,
        from: 'Bob <bob@example.com>',
        body: `Looks good.\n\nOn Tue, Alice wrote:\n> First draft\n> more\n> more`,
        refs: `root-${tag}`,
      }),
      ['\\Seen'],
    );
    await append(
      message({
        id: `news-${tag}`,
        subject: `Newsletter ${tag}`,
        from: 'News <no-reply@news.example>',
        body: 'Deals',
        extra: 'List-Unsubscribe: <mailto:u@news.example>',
      }),
    );
  });

  it('rejects bad credentials with an AuthError', async () => {
    await expect(new ImapProvider(config, 'wrong').verify()).rejects.toBeInstanceOf(AuthError);
  });

  it('lists folders', async () => {
    expect((await provider.listFolders()).map((f) => f.id)).toContain('INBOX');
  });

  it('searches with filters, flags automated mail and pages by UID', async () => {
    const all = await provider.search({ subject: tag }, 10);
    expect(all.messages.map((m) => m.subject).sort()).toEqual([
      `Newsletter ${tag}`,
      `Plan ${tag}`,
      `Re: Plan ${tag}`,
    ]);
    expect(all.messages.find((m) => m.subject.startsWith('Newsletter'))?.automated).toBe(true);

    const unread = await provider.search({ subject: tag, unread: true, excludeAutomated: true }, 10);
    expect(unread.messages.map((m) => m.subject)).toEqual([`Plan ${tag}`]);

    const first = await provider.search({ subject: tag }, 2);
    expect(first.messages).toHaveLength(2);
    const second = await provider.search({ subject: tag }, 2, first.nextCursor);
    expect(second.messages).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();

    await expect(provider.search({ rawQuery: 'from:alice' }, 10)).rejects.toThrow(/rawQuery/);
  });

  it('fetches a cleaned message without marking it read, and reconstructs the thread', async () => {
    const [reply] = (await provider.search({ subject: `Re: Plan ${tag}` }, 1)).messages;
    const full = await provider.getMessage(reply?.providerId as string);
    expect(full.body).toBe('Looks good.\n\n[quoted text collapsed]');

    const rootQuery = { subject: `Plan ${tag}`, from: 'alice@example.com' };
    const [root] = (await provider.search(rootQuery, 1)).messages;
    await provider.getMessage(root?.providerId as string);
    const [after] = (await provider.search(rootQuery, 1)).messages;
    expect(after?.unread).toBe(true);

    const thread = await provider.getThread(reply?.threadId as string, 10);
    expect(thread.map((m) => m.summary.subject)).toEqual([`Plan ${tag}`, `Re: Plan ${tag}`]);
  });

  it('returns only new messages after a checkpoint', async () => {
    const first = await provider.changesSince(undefined, 200);
    expect(first.messages.length).toBeGreaterThanOrEqual(3);
    const none = await provider.changesSince(first.checkpoint, 200);
    expect(none.messages).toHaveLength(0);
    await append(
      message({ id: `new-${tag}`, subject: `New ${tag}`, from: 'Carol <c@example.com>', body: 'hi' }),
    );
    const next = await provider.changesSince(first.checkpoint, 200);
    expect(next.messages.map((m) => m.subject)).toEqual([`New ${tag}`]);
  });

  it('delivers the oldest new messages first and resumes after them when truncated', async () => {
    const { checkpoint } = await provider.changesSince(undefined, 1000);
    for (const n of [1, 2, 3]) {
      await append(
        message({ id: `burst${n}-${tag}`, subject: `Burst ${n} ${tag}`, from: 'd@example.com', body: '.' }),
      );
    }
    const first = await provider.changesSince(checkpoint, 2);
    expect(first.truncated).toBe(true);
    expect(first.messages.map((m) => m.subject).sort()).toEqual([`Burst 1 ${tag}`, `Burst 2 ${tag}`]);
    const rest = await provider.changesSince(first.checkpoint, 2);
    expect(rest.truncated).toBe(false);
    expect(rest.messages.map((m) => m.subject)).toEqual([`Burst 3 ${tag}`]);
  });

  it('survives an unparseable Date header by using the internal date', async () => {
    const raw = message({
      id: `baddate-${tag}`,
      subject: `Bad date ${tag}`,
      from: 'e@example.com',
      body: '.',
    }).replace(/^Date: .*$/m, 'Date: Tue, 18 Nov 2026 10:00:00 CEST');
    await append(raw);
    const [m] = (await provider.search({ subject: `Bad date ${tag}` }, 1)).messages;
    expect(m && Number.isNaN(Date.parse(m.date))).toBe(false);
    expect(Date.now() - Date.parse(m?.date ?? '')).toBeLessThan(60_000);
  });

  it('reports a missing folder as a user error', async () => {
    await expect(provider.search({ folder: `Missing-${tag}` }, 1)).rejects.toBeInstanceOf(UserError);
  });

  it('fails loudly on ids from a different UIDVALIDITY', async () => {
    const [m] = (await provider.search({ subject: tag }, 1)).messages;
    if (!m) throw new Error('expected a message');
    const stale = m.providerId.replace(/^\d+/, '4242');
    await expect(provider.getMessage(stale)).rejects.toThrow(/UIDVALIDITY/);
  });
});
