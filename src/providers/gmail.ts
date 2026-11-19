import { htmlToText, isAutomated, parseRaw, snippetOf } from '../mail/parse.js';
import {
  type Changes,
  type Checkpoint,
  DAY_SECONDS,
  type Folder,
  type FullMessage,
  type MailProvider,
  type MessageSummary,
  type Page,
  type SearchQuery,
} from '../mail/types.js';
import { authedJson, HttpError, mapLimit, type RefreshingToken } from './oauth.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SUMMARY_HEADERS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'List-Unsubscribe',
  'List-Id',
  'Precedence',
  'Auto-Submitted',
];
const BULK_QUERY = '-category:promotions -category:social -category:updates -category:forums';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  raw?: string;
  payload?: { mimeType?: string; headers?: Array<{ name: string; value: string }> };
}

interface GmailCheckpoint {
  historyId?: string;
  at: number;
  seen?: string[];
}

const newestSecond = (messages: MessageSummary[]) => {
  const newest = messages
    .map((m) => m.date)
    .sort()
    .at(-1);
  return newest ? Math.floor(Date.parse(newest) / 1000) : undefined;
};

const quote = (v: string) => `(${v.replace(/[()]/g, ' ')})`;
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

export function buildGmailQuery(q: SearchQuery): string {
  const parts: string[] = [];
  if (q.from) parts.push(`from:${quote(q.from)}`);
  if (q.to) parts.push(`to:${quote(q.to)}`);
  if (q.subject) parts.push(`subject:${quote(q.subject)}`);
  if (q.text) parts.push(q.text);
  if (q.since) parts.push(`after:${epoch(q.since)}`);
  if (q.before) parts.push(`before:${epoch(q.before)}`);
  if (q.unread === true) parts.push('is:unread');
  if (q.unread === false) parts.push('-is:unread');
  if (q.hasAttachment === true) parts.push('has:attachment');
  if (q.hasAttachment === false) parts.push('-has:attachment');
  if (q.excludeAutomated) parts.push(BULK_QUERY);
  if (q.rawQuery) parts.push(q.rawQuery);
  return parts.join(' ');
}

export class GmailProvider implements MailProvider {
  constructor(private readonly token: RefreshingToken) {}

  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.get('/profile');
  }

  async listFolders(): Promise<Folder[]> {
    const res = await this.get<{ labels?: Array<{ id: string; name: string; type: string }> }>('/labels');
    return (res.labels ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      specialUse: l.type === 'system' ? l.id : undefined,
    }));
  }

  async search(query: SearchQuery, limit: number, cursor?: string): Promise<Page> {
    const params = new URLSearchParams({ maxResults: String(limit) });
    const q = buildGmailQuery(query);
    if (q) params.set('q', q);
    if (query.folder) params.append('labelIds', query.folder);
    if (cursor) params.set('pageToken', cursor);
    const res = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      `/messages?${params}`,
    );
    let messages = await this.summaries((res.messages ?? []).map((m) => m.id));
    if (query.excludeAutomated) messages = messages.filter((m) => !m.automated);
    return { messages, nextCursor: res.nextPageToken };
  }

  async getMessage(providerId: string): Promise<FullMessage> {
    const msg = await this.get<GmailMessage>(`/messages/${encodeURIComponent(providerId)}?format=raw`);
    const parsed = await parseRaw(Buffer.from(msg.raw ?? '', 'base64url'));
    const labels = msg.labelIds ?? [];
    return {
      summary: {
        providerId: msg.id,
        threadId: msg.threadId,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        date: dateOf(msg, parsed.date),
        snippet: snippetOf(parsed.body),
        unread: labels.includes('UNREAD'),
        labels,
        hasAttachments: parsed.attachments.length > 0,
        automated: isAutomated({ header: parsed.header, fromAddress: parsed.fromAddress, labels }),
      },
      body: parsed.body,
      attachments: parsed.attachments,
    };
  }

  async getThread(threadId: string, limit: number): Promise<FullMessage[]> {
    const thread = await this.get<{ messages?: GmailMessage[] }>(
      `/threads/${encodeURIComponent(threadId)}?format=minimal`,
    );
    const ids = (thread.messages ?? []).map((m) => m.id).slice(-limit);
    return mapLimit(ids, 5, (id) => this.getMessage(id));
  }

  async changesSince(checkpoint: Checkpoint | undefined, limit: number): Promise<Changes> {
    const cp = checkpoint as GmailCheckpoint | undefined;
    const startedAt = Math.floor(Date.now() / 1000);
    if (cp?.historyId) {
      try {
        const { records, historyId } = await this.history(cp.historyId);
        const ids: string[] = [];
        let lastRecordId: string | undefined;
        let truncated = false;
        for (const record of records) {
          const fresh = record.messageIds.filter((id) => !ids.includes(id));
          if (ids.length > 0 && ids.length + fresh.length > limit) {
            truncated = true;
            break;
          }
          ids.push(...fresh);
          lastRecordId = record.id;
        }
        const messages = await this.summaries(ids);
        const resumeAt = truncated ? (newestSecond(messages) ?? cp.at) - 1 : startedAt;
        return {
          messages,
          checkpoint: { historyId: truncated ? lastRecordId : historyId, at: resumeAt },
          truncated,
        };
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    }

    const { historyId } = await this.profile();
    const since = cp?.at ?? startedAt - DAY_SECONDS;
    const skip = cp?.historyId ? [] : (cp?.seen ?? []);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: `in:inbox after:${since}`, maxResults: '500' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
        `/messages?${params}`,
      );
      ids.push(...(res.messages ?? []).map((m) => m.id).filter((id) => !skip.includes(id)));
      pageToken = res.nextPageToken;
    } while (pageToken);

    const oldestFirst = ids.reverse();
    const messages = await this.summaries(oldestFirst.slice(0, limit));
    if (oldestFirst.length <= limit) {
      return { messages, checkpoint: { historyId, at: startedAt } };
    }
    const at = (newestSecond(messages) ?? since + 1) - 1;
    const boundary = messages
      .filter((m) => Math.floor(Date.parse(m.date) / 1000) >= at)
      .map((m) => m.providerId);
    return {
      messages,
      checkpoint: { at, seen: at === since ? [...skip, ...boundary] : boundary },
      truncated: true,
    };
  }

  private async history(
    startHistoryId: string,
  ): Promise<{ records: Array<{ id: string; messageIds: string[] }>; historyId: string }> {
    const records: Array<{ id: string; messageIds: string[] }> = [];
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    do {
      const params = new URLSearchParams({ startHistoryId, labelId: 'INBOX', maxResults: '500' });
      params.append('historyTypes', 'messageAdded');
      params.append('historyTypes', 'labelAdded');
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.get<{
        history?: Array<{
          id: string;
          messagesAdded?: Array<{ message: GmailMessage }>;
          labelsAdded?: Array<{ message: GmailMessage; labelIds: string[] }>;
        }>;
        historyId: string;
        nextPageToken?: string;
      }>(`/history?${params}`);
      for (const h of res.history ?? []) {
        const messageIds = [
          ...(h.messagesAdded ?? [])
            .filter((a) => !a.message.labelIds || a.message.labelIds.includes('INBOX'))
            .map((a) => a.message.id),
          ...(h.labelsAdded ?? []).filter((a) => a.labelIds.includes('INBOX')).map((a) => a.message.id),
        ];
        if (messageIds.length > 0) records.push({ id: h.id, messageIds });
      }
      historyId = res.historyId;
      pageToken = res.nextPageToken;
    } while (pageToken);
    return { records, historyId };
  }

  private async summaries(ids: string[]): Promise<MessageSummary[]> {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const h of SUMMARY_HEADERS) params.append('metadataHeaders', h);
    const messages = await mapLimit(ids, 10, (id) =>
      this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}?${params}`).catch((err) => {
        if (err instanceof HttpError && err.status === 404) return undefined;
        throw err;
      }),
    );
    return messages
      .filter((m): m is GmailMessage => Boolean(m))
      .map(summaryOf)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  private get<T>(path: string): Promise<T> {
    return authedJson<T>(this.token, `${API}${path}`);
  }
}

function dateOf(msg: GmailMessage, fallback?: Date): string {
  if (msg.internalDate) return new Date(Number(msg.internalDate)).toISOString();
  return (fallback ?? new Date(0)).toISOString();
}

function summaryOf(msg: GmailMessage): MessageSummary {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
  const labels = msg.labelIds ?? [];
  const from = header('From');
  const list = (v?: string) => (v ? v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()) : []);
  return {
    providerId: msg.id,
    threadId: msg.threadId,
    from,
    to: list(header('To')),
    cc: list(header('Cc')),
    subject: header('Subject') ?? '',
    date: dateOf(msg),
    snippet: snippetOf(htmlToText(msg.snippet ?? '')),
    unread: labels.includes('UNREAD'),
    labels,
    hasAttachments: msg.payload?.mimeType === 'multipart/mixed',
    automated: isAutomated({ header, fromAddress: from?.match(/<([^>]+)>/)?.[1] ?? from, labels }),
  };
}
