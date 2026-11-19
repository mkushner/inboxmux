import { isAutomated, parseRaw, snippetOf } from '../mail/parse.js';
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
  UserError,
} from '../mail/types.js';
import { authedFetch, authedJson, mapLimit, type RefreshingToken } from './oauth.js';

const API = 'https://graph.microsoft.com/v1.0/me';
const SELECT =
  'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,parentFolderId';

export const GRAPH_SCOPE =
  'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read';

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  parentFolderId?: string;
}

interface ListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  childFolderCount?: number;
}

const MAX_FOLDERS = 1000;

interface GraphCheckpoint {
  at: string;
  seen: string[];
}

const kqlValue = (v: string) => v.replace(/["\\]/g, ' ').trim();
const kqlRaw = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();
const day = (d: Date) => d.toISOString().slice(0, 10);
const dayAfter = (d: Date) =>
  d.toISOString().endsWith('T00:00:00.000Z') ? day(d) : day(new Date(d.getTime() + DAY_SECONDS * 1000));

export function buildGraphRequest(q: SearchQuery, limit: number): string {
  const params = new URLSearchParams({ $select: SELECT, $top: String(limit) });
  const kql: string[] = [];
  if (q.from) kql.push(`from:${kqlValue(q.from)}`);
  if (q.to) kql.push(`to:${kqlValue(q.to)}`);
  if (q.subject)
    kql.push(
      ...kqlValue(q.subject)
        .split(/\s+/)
        .map((w) => `subject:${w}`),
    );
  if (q.text) kql.push(kqlValue(q.text));
  if (q.rawQuery) kql.push(kqlRaw(q.rawQuery));
  const base = q.folder ? `${API}/mailFolders/${encodeURIComponent(q.folder)}/messages` : `${API}/messages`;

  if (kql.length > 0) {
    if (q.since) kql.push(`received>=${day(q.since)}`);
    if (q.before) kql.push(`received<${dayAfter(q.before)}`);
    if (q.hasAttachment !== undefined) kql.push(`hasAttachments:${q.hasAttachment}`);
    params.set('$search', `"${kql.join(' AND ')}"`);
    return `${base}?${params}`;
  }

  const filter = [`receivedDateTime ge ${(q.since ?? new Date(0)).toISOString()}`];
  if (q.before) filter.push(`receivedDateTime lt ${q.before.toISOString()}`);
  if (q.unread !== undefined) filter.push(`isRead eq ${!q.unread}`);
  if (q.hasAttachment !== undefined) filter.push(`hasAttachments eq ${q.hasAttachment}`);
  params.set('$filter', filter.join(' and '));
  params.set('$orderby', 'receivedDateTime desc');
  return `${base}?${params}`;
}

export class GraphProvider implements MailProvider {
  constructor(private readonly token: RefreshingToken) {}

  async profile(): Promise<{ email: string }> {
    const me = await authedJson<{ mail?: string; userPrincipalName: string }>(this.token, API);
    return { email: me.mail ?? me.userPrincipalName };
  }

  async listFolders(): Promise<Folder[]> {
    const query = '$top=100&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount';
    const folders: Folder[] = [];
    const queue: Array<{ url: string; parent: string }> = [
      { url: `${API}/mailFolders?${query}`, parent: '' },
    ];
    while (queue.length > 0 && folders.length < MAX_FOLDERS) {
      const { url, parent } = queue.shift() as { url: string; parent: string };
      const res = await this.get<ListResponse<GraphFolder>>(url);
      for (const f of res.value) {
        const name = parent ? `${parent}/${f.displayName}` : f.displayName;
        folders.push({ id: f.id, name, total: f.totalItemCount, unread: f.unreadItemCount });
        if (f.childFolderCount) {
          queue.push({
            url: `${API}/mailFolders/${encodeURIComponent(f.id)}/childFolders?${query}`,
            parent: name,
          });
        }
      }
      const next = res['@odata.nextLink'];
      if (next) queue.push({ url: next, parent });
    }
    return folders;
  }

  async search(query: SearchQuery, limit: number, cursor?: string): Promise<Page> {
    const url = cursor ?? buildGraphRequest(query, limit);
    if (!url.startsWith(`${API}/`)) throw new UserError('Invalid cursor');
    const res = await this.get<ListResponse<GraphMessage>>(url);
    let messages = res.value.map(summaryOf).sort((a, b) => b.date.localeCompare(a.date));
    if (query.unread !== undefined) messages = messages.filter((m) => m.unread === query.unread);
    if (query.hasAttachment !== undefined) {
      messages = messages.filter((m) => m.hasAttachments === query.hasAttachment);
    }
    if (query.excludeAutomated) messages = messages.filter((m) => !m.automated);
    return { messages, nextCursor: res['@odata.nextLink'] };
  }

  async getMessage(providerId: string): Promise<FullMessage> {
    const id = encodeURIComponent(providerId);
    const [meta, mime] = await Promise.all([
      this.get<GraphMessage>(`${API}/messages/${id}?$select=${SELECT}`),
      authedFetch(this.token, `${API}/messages/${id}/$value`).then((r) => r.arrayBuffer()),
    ]);
    const parsed = await parseRaw(Buffer.from(mime));
    const summary = summaryOf(meta);
    summary.automated = isAutomated({ header: parsed.header, fromAddress: parsed.fromAddress });
    summary.snippet = snippetOf(parsed.body);
    return { summary, body: parsed.body, attachments: parsed.attachments };
  }

  async getThread(threadId: string, limit: number): Promise<FullMessage[]> {
    const params = new URLSearchParams({
      $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      $select: 'id,receivedDateTime',
      $top: '50',
    });
    const res = await this.get<ListResponse<GraphMessage>>(`${API}/messages?${params}`);
    const ids = res.value
      .sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime))
      .map((m) => m.id)
      .slice(-limit);
    return mapLimit(ids, 5, (id) => this.getMessage(id));
  }

  async changesSince(checkpoint: Checkpoint | undefined, limit: number): Promise<Changes> {
    const cp = checkpoint as GraphCheckpoint | undefined;
    const at = cp?.at ?? new Date(Date.now() - DAY_SECONDS * 1000).toISOString();
    const params = new URLSearchParams({
      $filter: `receivedDateTime ge ${at}`,
      $orderby: 'receivedDateTime asc',
      $select: SELECT,
      $top: '50',
    });
    const seen = cp?.seen ?? [];
    const found: GraphMessage[] = [];
    let url: string | undefined = `${API}/mailFolders/inbox/messages?${params}`;
    while (url && found.length <= limit) {
      const res: ListResponse<GraphMessage> = await this.get<ListResponse<GraphMessage>>(url);
      found.push(...res.value.filter((m) => !seen.includes(m.id)));
      url = res['@odata.nextLink'];
    }
    const batch = found.slice(0, limit);
    const last = batch[batch.length - 1];
    if (!last) return { messages: [], checkpoint: { at, seen } };
    const nextAt = last.receivedDateTime;
    const boundary = batch.filter((m) => m.receivedDateTime === nextAt).map((m) => m.id);
    return {
      messages: batch.reverse().map(summaryOf),
      checkpoint: { at: nextAt, seen: nextAt === at ? [...seen, ...boundary] : boundary },
      truncated: found.length > limit,
    };
  }

  private get<T>(url: string): Promise<T> {
    return authedJson<T>(this.token, url);
  }
}

function address(r?: Recipient): string | undefined {
  const e = r?.emailAddress;
  if (!e?.address) return e?.name;
  return e.name && e.name !== e.address ? `${e.name} <${e.address}>` : e.address;
}

function summaryOf(m: GraphMessage): MessageSummary {
  const fromAddress = m.from?.emailAddress?.address;
  return {
    providerId: m.id,
    threadId: m.conversationId,
    from: address(m.from),
    to: (m.toRecipients ?? []).map(address).filter((a): a is string => Boolean(a)),
    cc: (m.ccRecipients ?? []).map(address).filter((a): a is string => Boolean(a)),
    subject: m.subject ?? '',
    date: new Date(m.receivedDateTime).toISOString(),
    snippet: snippetOf(m.bodyPreview ?? ''),
    unread: m.isRead === false,
    folder: m.parentFolderId,
    hasAttachments: Boolean(m.hasAttachments),
    automated: isAutomated({ header: () => undefined, fromAddress }),
  };
}
