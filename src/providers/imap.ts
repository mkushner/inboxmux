import { type FetchMessageObject, type FetchQueryObject, ImapFlow, type SearchObject } from 'imapflow';
import { formatAddress, isAutomated, parseRaw, snippetOf } from '../mail/parse.js';
import {
  AuthError,
  type Changes,
  type Checkpoint,
  DAY_SECONDS,
  type Folder,
  type FullMessage,
  type MailProvider,
  type MessageSummary,
  type Page,
  type SearchQuery,
  UnsupportedError,
  UserError,
} from '../mail/types.js';

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
}

const SUMMARY_SOURCE_BYTES = 24_576;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export function encodeImapId(folder: string, uidValidity: bigint | string, uid: number) {
  return `${uidValidity}.${uid}.${b64(folder)}`;
}

export function decodeImapId(id: string) {
  const [validity, uid, folder] = id.split('.');
  if (!validity || !uid || !folder || !/^\d+$/.test(validity) || !/^\d+$/.test(uid)) {
    throw new UserError(`Malformed IMAP message id "${id}"`);
  }
  return { uidValidity: validity, uid: Number(uid), folder: unb64(folder) };
}

interface ImapCheckpoint {
  uidValidity: string;
  uidNext: number;
  at: number;
}

export class ImapProvider implements MailProvider {
  constructor(
    private readonly config: ImapConfig,
    private readonly password: string,
  ) {}

  async verify(): Promise<void> {
    await this.session(async () => undefined);
  }

  async listFolders(): Promise<Folder[]> {
    return this.session(async (client) => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true } });
      return list
        .filter((f) => !f.flags.has('\\Noselect'))
        .map((f) => ({
          id: f.path,
          name: f.path,
          specialUse: f.specialUse,
          total: f.status?.messages,
          unread: f.status?.unseen,
        }));
    });
  }

  async search(query: SearchQuery, limit: number, cursor?: string): Promise<Page> {
    return this.session(async (client) => {
      const gmail = client.capabilities.has('X-GM-EXT-1');
      if (query.rawQuery && !gmail) {
        throw new UnsupportedError('rawQuery is only supported for Gmail IMAP and Gmail/Graph accounts');
      }
      const folder = query.folder ?? (gmail ? await allMailFolder(client) : 'INBOX');
      const criteria: SearchObject = {};
      if (query.from) criteria.from = query.from;
      if (query.to) criteria.to = query.to;
      if (query.subject) criteria.subject = query.subject;
      if (query.text) criteria.text = query.text;
      if (query.since) criteria.since = query.since;
      if (query.before) criteria.before = query.before;
      if (query.unread !== undefined) criteria.seen = !query.unread;
      if (query.rawQuery) criteria.gmraw = query.rawQuery;
      if (Object.keys(criteria).length === 0) criteria.all = true;

      const lock = await lockFolder(client, folder);
      try {
        const before = cursor ? Number(cursor) : Number.POSITIVE_INFINITY;
        const uids = (await searchUids(client, folder, criteria))
          .filter((uid) => uid < before)
          .sort((a, b) => b - a);
        const page = uids.slice(0, limit);
        let messages = await this.summaries(client, folder, page, gmail);
        if (query.hasAttachment !== undefined) {
          messages = messages.filter((m) => m.hasAttachments === query.hasAttachment);
        }
        if (query.excludeAutomated) messages = messages.filter((m) => !m.automated);
        const last = page[page.length - 1];
        return { messages, nextCursor: uids.length > limit && last ? String(last) : undefined };
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(providerId: string): Promise<FullMessage> {
    const { folder, uid, uidValidity } = decodeImapId(providerId);
    return this.session(async (client) => {
      const lock = await lockFolder(client, folder);
      try {
        assertValidity(client, folder, uidValidity);
        const msg = await client.fetchOne(String(uid), fetchQuery(client, true), { uid: true });
        if (!msg) throw new UserError(`Message ${providerId} not found`);
        return this.full(client, folder, msg);
      } finally {
        lock.release();
      }
    });
  }

  async getThread(threadId: string, limit: number): Promise<FullMessage[]> {
    return this.session(async (client) => {
      const [kind, a, b] = threadId.split('.');
      const targets: Array<{ folder: string; criteria: SearchObject }> = [];
      if (kind === 't' && a) {
        targets.push({ folder: await allMailFolder(client), criteria: { threadId: a } });
      } else if (kind === 'r' && a && b) {
        const root = unb64(b);
        const criteria: SearchObject = {
          or: [{ header: { 'message-id': root } }, { header: { references: root } }],
        };
        targets.push({ folder: unb64(a), criteria });
        const sent = (await client.list()).find((f) => f.specialUse === '\\Sent');
        if (sent && sent.path !== unb64(a)) targets.push({ folder: sent.path, criteria });
      } else {
        throw new UserError(`Malformed IMAP thread id "${threadId}"`);
      }

      const messages: FullMessage[] = [];
      for (const { folder, criteria } of targets) {
        const lock = await lockFolder(client, folder);
        try {
          const uids = (await searchUids(client, folder, criteria)).sort((x, y) => x - y).slice(-limit);
          if (uids.length === 0) continue;
          for await (const msg of client.fetch(uids, fetchQuery(client, true), { uid: true })) {
            messages.push(await this.full(client, folder, msg));
          }
        } finally {
          lock.release();
        }
      }
      return messages.sort((x, y) => x.summary.date.localeCompare(y.summary.date)).slice(-limit);
    });
  }

  async changesSince(checkpoint: Checkpoint | undefined, limit: number): Promise<Changes> {
    const cp = checkpoint as ImapCheckpoint | undefined;
    return this.session(async (client) => {
      const gmail = client.capabilities.has('X-GM-EXT-1');
      const lock = await lockFolder(client, 'INBOX');
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error('INBOX did not open');
        const uidValidity = mailbox.uidValidity.toString();
        const startedAt = Math.floor(Date.now() / 1000);
        const sinceTs = cp?.at ?? startedAt - DAY_SECONDS;

        let uids: number[] = [];
        if (cp && cp.uidValidity === uidValidity) {
          uids = (await searchUids(client, 'INBOX', { uid: `${cp.uidNext}:*` })).filter(
            (uid) => uid >= cp.uidNext,
          );
        } else {
          const sinceMs = sinceTs * 1000;
          const candidates = await searchUids(client, 'INBOX', { since: new Date(sinceMs) });
          if (candidates.length > 0) {
            for await (const m of client.fetch(
              candidates,
              { uid: true, internalDate: true },
              { uid: true },
            )) {
              if (m.internalDate && new Date(m.internalDate).getTime() >= sinceMs) uids.push(m.uid);
            }
          }
        }
        uids.sort((a, b) => a - b);
        const batch = uids.slice(0, limit);
        const truncated = uids.length > limit;
        const messages = await this.summaries(client, 'INBOX', batch, gmail);
        const lastUid = batch[batch.length - 1];
        const newest = messages
          .map((m) => m.date)
          .sort()
          .at(-1);
        const next: ImapCheckpoint =
          truncated && lastUid && newest
            ? { uidValidity, uidNext: lastUid + 1, at: Math.floor(Date.parse(newest) / 1000) }
            : { uidValidity, uidNext: mailbox.uidNext, at: startedAt };
        return { messages, checkpoint: { ...next }, truncated };
      } finally {
        lock.release();
      }
    });
  }

  private async session<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      if ((err as { authenticationFailed?: boolean }).authenticationFailed) {
        throw new AuthError('IMAP login failed: check the username and app password');
      }
      throw err;
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private async summaries(
    client: ImapFlow,
    folder: string,
    uids: number[],
    gmail: boolean,
  ): Promise<MessageSummary[]> {
    if (uids.length === 0) return [];
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error(`${folder} is not open`);
    const out: MessageSummary[] = [];
    const query: FetchQueryObject = {
      ...fetchQuery(client, false),
      source: { maxLength: SUMMARY_SOURCE_BYTES },
    };
    for await (const msg of client.fetch(uids, query, { uid: true })) {
      const parsed = await parseRaw(msg.source ?? '');
      out.push(summaryOf(msg, folder, mailbox.uidValidity, parsed, gmail));
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  private async full(client: ImapFlow, folder: string, msg: FetchMessageObject): Promise<FullMessage> {
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error(`${folder} is not open`);
    const parsed = await parseRaw(msg.source ?? '');
    const gmail = client.capabilities.has('X-GM-EXT-1');
    return {
      summary: summaryOf(msg, folder, mailbox.uidValidity, parsed, gmail),
      body: parsed.body,
      attachments: parsed.attachments,
    };
  }
}

function fetchQuery(client: ImapFlow, fullSource: boolean): FetchQueryObject {
  const gmail = client.capabilities.has('X-GM-EXT-1');
  return {
    uid: true,
    flags: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    threadId: gmail,
    labels: gmail,
    source: fullSource,
  };
}

function assertValidity(client: ImapFlow, folder: string, expected: string) {
  const actual = client.mailbox ? client.mailbox.uidValidity.toString() : undefined;
  if (actual !== expected) {
    throw new UserError(
      `Stale message id: UIDVALIDITY of "${folder}" changed. Search again to get fresh ids.`,
    );
  }
}

async function lockFolder(client: ImapFlow, folder: string) {
  try {
    return await client.getMailboxLock(folder, { readOnly: true });
  } catch (err) {
    const status = (err as { responseStatus?: string }).responseStatus;
    if (status === 'NO' || status === 'BAD') throw new UserError(`Folder "${folder}" cannot be opened`);
    throw err;
  }
}

async function searchUids(client: ImapFlow, folder: string, criteria: SearchObject): Promise<number[]> {
  const result = await client.search(criteria, { uid: true });
  if (!Array.isArray(result))
    throw new Error(`The IMAP server refused a SEARCH in "${folder}"; try again later`);
  return result;
}

function isoDate(...candidates: Array<Date | string | undefined>): string {
  for (const c of candidates) {
    const t = c === undefined ? Number.NaN : new Date(c).getTime();
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date(0).toISOString();
}

async function allMailFolder(client: ImapFlow): Promise<string> {
  const all = (await client.list()).find((f) => f.specialUse === '\\All');
  return all?.path ?? 'INBOX';
}

function hasAttachment(node: FetchMessageObject['bodyStructure']): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (
    !node.type.startsWith('multipart/') &&
    !node.type.startsWith('text/') &&
    node.dispositionParameters?.filename
  ) {
    return true;
  }
  return node.childNodes?.some(hasAttachment) ?? false;
}

function summaryOf(
  msg: FetchMessageObject,
  folder: string,
  uidValidity: bigint,
  parsed: Awaited<ReturnType<typeof parseRaw>>,
  gmail: boolean,
): MessageSummary {
  const from = msg.envelope?.from?.[0];
  const labels = msg.labels ? [...msg.labels] : undefined;
  const root = parsed.references[0] ?? parsed.messageId ?? msg.envelope?.messageId;
  const threadId =
    gmail && msg.threadId ? `t.${msg.threadId}` : root ? `r.${b64(folder)}.${b64(root)}` : undefined;
  return {
    providerId: encodeImapId(folder, uidValidity, msg.uid),
    threadId,
    from: from ? formatAddress(from) : parsed.from,
    to: msg.envelope?.to?.map(formatAddress) ?? parsed.to,
    cc: msg.envelope?.cc?.map(formatAddress) ?? parsed.cc,
    subject: msg.envelope?.subject ?? parsed.subject,
    date: isoDate(msg.internalDate, msg.envelope?.date, parsed.date),
    snippet: snippetOf(parsed.body),
    unread: !msg.flags?.has('\\Seen'),
    folder,
    labels,
    hasAttachments: hasAttachment(msg.bodyStructure),
    automated: isAutomated({
      header: parsed.header,
      fromAddress: from?.address ?? parsed.fromAddress,
      labels,
    }),
  };
}
