export interface ImapPreset {
  label: string;
  host: string;
  port: number;
  secure: boolean;
}

export const IMAP_PRESETS: Record<string, ImapPreset> = {
  godaddy: { label: 'GoDaddy Professional Email (Titan)', host: 'imap.titan.email', port: 993, secure: true },
  'titan-eu': { label: 'Titan (EU-hosted)', host: 'imap0101.titan.email', port: 993, secure: true },
  fastmail: { label: 'Fastmail', host: 'imap.fastmail.com', port: 993, secure: true },
  icloud: { label: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, secure: true },
  yahoo: { label: 'Yahoo Mail', host: 'imap.mail.yahoo.com', port: 993, secure: true },
  gmail: { label: 'Gmail via IMAP (app password)', host: 'imap.gmail.com', port: 993, secure: true },
};
