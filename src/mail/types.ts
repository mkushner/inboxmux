export interface MessageSummary {
  providerId: string;
  threadId?: string;
  from?: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  folder?: string;
  labels?: string[];
  hasAttachments: boolean;
  automated: boolean;
}

export interface AttachmentMeta {
  name?: string;
  type: string;
  size: number;
}

export interface FullMessage {
  summary: MessageSummary;
  body: string;
  attachments: AttachmentMeta[];
}

export interface Folder {
  id: string;
  name: string;
  specialUse?: string;
  total?: number;
  unread?: number;
}

export interface SearchQuery {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unread?: boolean;
  folder?: string;
  hasAttachment?: boolean;
  excludeAutomated?: boolean;
  rawQuery?: string;
}

export interface Page {
  messages: MessageSummary[];
  nextCursor?: string;
}

export type Checkpoint = Record<string, unknown>;

export interface Changes {
  messages: MessageSummary[];
  checkpoint: Checkpoint;
  truncated?: boolean;
}

export interface MailProvider {
  listFolders(): Promise<Folder[]>;
  search(query: SearchQuery, limit: number, cursor?: string): Promise<Page>;
  getMessage(providerId: string): Promise<FullMessage>;
  getThread(threadId: string, limit: number): Promise<FullMessage[]>;
  changesSince(checkpoint: Checkpoint | undefined, limit: number): Promise<Changes>;
}

export class AuthError extends Error {}

export class UserError extends Error {}

export class UnsupportedError extends UserError {}

export const DAY_SECONDS = 86_400;
