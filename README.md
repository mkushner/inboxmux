# inboxmux

A self-hosted, remote [MCP](https://modelcontextprotocol.io) server that puts many mailboxes behind one connector. Add it to Claude (or any MCP client that speaks Streamable HTTP + OAuth) once, and search and triage mail across all your accounts.

- **Providers:** Gmail and Google Workspace (OAuth), Microsoft 365 and Outlook.com (Microsoft Graph), and any IMAP host. Presets cover GoDaddy Professional Email (Titan), Fastmail, iCloud, Yahoo and Gmail over IMAP.
- **Read-only.** Gmail uses `gmail.readonly`, Microsoft uses `Mail.Read`, and IMAP opens folders read-only and never sets `\Seen`.
- **Built for scheduled triage.** `get_changes` returns what arrived since the last run, and delivery is at-least-once: nothing is skipped until you `ack_changes`.
- **Compact output.** Search returns summaries. A body is returned only when you ask for one, as plain text with quoted replies collapsed and signatures trimmed.
- **Treats email as untrusted.** Bodies come wrapped in explicit delimiters. Links and remote images are never fetched.
- **Secure by default.** It implements MCP authorization (OAuth 2.1, PKCE, Client ID Metadata Documents and Dynamic Client Registration, rotating refresh tokens). Owners sign in with Google, limited to an email allowlist. Provider secrets are encrypted with AES-256-GCM, and every tool call is audited without storing message content.

## Quickstart (Docker Compose)

You need a server with Docker, a DNS name pointing at it, and ports 80 and 443 open.

```sh
git clone https://github.com/mkushner/inboxmux && cd inboxmux
cp .env.example .env
docker compose run --rm inboxmux node dist/cli.js gen-key   # paste into INBOXMUX_ENCRYPTION_KEY as k1:<key>
# fill in INBOXMUX_DOMAIN, OWNER_EMAILS, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
docker compose up -d
```

Caddy obtains the TLS certificate. Open `https://<your-domain>/admin`, sign in with an allowed Google account, and add mailboxes.

Creating the Google OAuth client takes about five minutes. Follow [docs/google-cloud.md](docs/google-cloud.md).

## Connect it to Claude

In Claude, open **Settings → Connectors → Add custom connector** and enter:

```
https://<your-domain>/mcp
```

Claude registers itself, then sends you to inboxmux to sign in and approve. After that the connector works in chats and in scheduled tasks. [docs/scheduled-triage.md](docs/scheduled-triage.md) has a ready-made prompt for triaging your inbox three times a day.

## Adding accounts

Everything happens at `/admin`.

| Provider | How |
| --- | --- |
| Gmail / Google Workspace | **Connect with Google**. Needs the Gmail API enabled in the same Google Cloud project ([guide](docs/google-cloud.md)). |
| Microsoft 365 / Outlook.com | **Connect with Microsoft**. Needs an Entra app registration ([guide](docs/microsoft.md)). |
| IMAP | Pick a preset or enter a host, then a username and an app password. The connection is tested before saving. |

Each account has an alias (`personal`, `work`, `sales`…). Tools take aliases and return ids shaped `<alias>:<id>`.

IMAP presets:

| Preset | Host | Notes |
| --- | --- | --- |
| GoDaddy Professional Email | `imap.titan.email:993` | Mailbox password. EU-hosted Titan uses `imap0101.titan.email`. |
| Fastmail | `imap.fastmail.com:993` | App password, not available on Basic plans |
| iCloud Mail | `imap.mail.me.com:993` | App-specific password, needs two-factor authentication |
| Yahoo Mail | `imap.mail.yahoo.com:993` | App password |
| Gmail via IMAP | `imap.gmail.com:993` | App password, needs 2-Step Verification. Skips the Google Cloud setup and supports `rawQuery` with Gmail syntax. |

Microsoft 365 mailboxes, including "Microsoft 365 from GoDaddy", disable basic-auth IMAP. Add them with **Connect with Microsoft**.

## Tools

All tools are read-only and annotated `readOnlyHint`.

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Aliases, provider, address, health (`ok` / `needs-reauth` / `error`) |
| `search_messages` | Structured filters (from, to, subject, text, since, before, unread, folder, hasAttachment, excludeAutomated) or a provider-native `rawQuery`. Fans out in parallel, merges by date and reports failing accounts separately. |
| `get_message` | One message as cleaned plain text plus attachment metadata, truncated to `maxChars` |
| `get_thread` | A conversation, oldest first. For plain IMAP it is rebuilt from `References`/`In-Reply-To`. |
| `list_folders` | Folders (IMAP, Microsoft) or labels (Gmail) |
| `get_changes` | New inbox mail since a named consumer's checkpoint, oldest first, up to `limit` per account. The first call covers the last 24 hours. `truncated` means more is waiting: ack, then call again. `peek` leaves state untouched. |
| `ack_changes` | Advances the consumer's checkpoint. It changes only inboxmux's read position, never your mailboxes. |

How changes are tracked: Gmail uses `historyId`, falling back to a time window when history has expired. IMAP uses `UIDVALIDITY` and `UIDNEXT` on INBOX. Microsoft uses `receivedDateTime` on the Inbox folder. A message moved into the Microsoft Inbox from another folder keeps its original received time, so it is not reported as new. Gmail and IMAP do report such moves.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `PUBLIC_URL` | yes | External base URL, such as `https://mail-mcp.example.com`. Docker Compose derives it from `INBOXMUX_DOMAIN`. |
| `INBOXMUX_ENCRYPTION_KEY` | yes | `id:base64key[,id:base64key…]`. The first key encrypts; every key decrypts. |
| `OWNER_EMAILS` | yes | Comma-separated Google accounts allowed to sign in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | OAuth client for owner sign-in and Gmail |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | no | Enables Microsoft accounts |
| `MICROSOFT_TENANT` | no | `common` (default), `organizations`, or a tenant id |
| `ALLOWED_REDIRECT_ORIGINS` | no | Comma-separated origins MCP clients may redirect to, for example `https://claude.ai,https://claude.com`. Loopback origins match any port. If empty, any client may connect after you approve it. |
| `DATABASE_PATH` | no | SQLite file. The default is `./data/inboxmux.db`, or `/data/inboxmux.db` in Docker. |
| `PORT` | no | HTTP port, default `8080` |

To rotate the encryption key:

1. Set `INBOXMUX_ENCRYPTION_KEY=k2:<new>,k1:<old>` and restart.
2. Run `docker compose exec inboxmux node dist/cli.js rotate-key`.
3. Remove `k1`.

## Development

Requires Node 22+ and Yarn 4.

```sh
yarn install
yarn typecheck && yarn lint && yarn test

# IMAP integration tests against GreenMail
docker compose -f docker-compose.test.yml up -d
yarn test:imap
```

`yarn dev` runs the server with reload. Use `PUBLIC_URL=http://localhost:8080`, since the OAuth endpoints allow plain HTTP on localhost only.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## License

[MIT](LICENSE)
