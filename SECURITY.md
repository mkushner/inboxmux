# Security

inboxmux holds credentials for people's mailboxes. Please treat vulnerabilities in it accordingly.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue. Expect an acknowledgement within a few days. Fixes ship as soon as they are ready, with credit if you want it.

## What inboxmux protects

- **Mailbox credentials:** IMAP passwords, plus Google and Microsoft refresh tokens. They are encrypted at rest with AES-256-GCM using `INBOXMUX_ENCRYPTION_KEY`, never logged, and never returned by any tool or page.
- **Mail content:** fetched on demand and never stored. The audit log records the time, client, tool, accounts touched, result count and errors. It never records message content.
- **Access to the MCP endpoint:** OAuth 2.1 bearer tokens bound to the `/mcp` resource.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Someone other than the owner connects a client | Authorization requires a Google sign-in whose verified email is in `OWNER_EMAILS`, followed by an explicit approval step. Removing an email from the list invalidates its sessions and tokens. |
| A malicious client tricks the owner into approving it | The consent page names the client and the origin it will redirect to. Redirect URIs must match the registration exactly (RFC 8252 port relaxation applies to loopback only). PKCE S256 is mandatory. Set `ALLOWED_REDIRECT_ORIGINS` to refuse every client that redirects anywhere else. |
| A connected client is compromised or no longer wanted | The admin page lists connected clients and revokes a client's tokens in one click. |
| IMAP password sent in clear | Implicit TLS by default. Without it, STARTTLS is required for every host except loopback, so a stripped STARTTLS capability fails the connection instead of downgrading it. |
| CSRF against the admin UI or consent | Server-side sessions, `__Host-` cookie with `HttpOnly`, `Secure` and `SameSite=Lax`, plus a per-session CSRF token on every POST |
| A stolen refresh token | Refresh tokens rotate on use. Replaying an old token more than 120 seconds after rotation revokes the whole grant. Access tokens live for one hour. |
| SSRF through Client ID Metadata Documents | Only `https` URLs, hosts that resolve to public addresses only, no redirects, 5-second timeout, 16 KB size limit. DNS rebinding between the check and the fetch is not prevented. |
| Database or backup leak | Secrets are encrypted, and OAuth tokens, codes and session ids are stored as SHA-256 hashes. Keep the encryption key out of the database's backups. |
| Prompt injection from email content | Bodies are wrapped in delimiters that the content cannot close, and tool descriptions say that email content is untrusted data. HTML becomes text with scripts, images and link targets removed, and nothing is fetched remotely. All tools are read-only. |
| One provider hangs or fails | Each account call has a timeout. Errors are reported per account and do not fail calls that span several accounts. |

### Residual risks

- **Exfiltration through other tools.** inboxmux cannot send mail. However, an assistant that also has tools to send messages or browse can be persuaded by a hostile email to use them. Give scheduled tasks that read mail as few other connectors as possible.
- **The encryption key is on the host.** Encryption at rest protects copies of the database, not a compromised running server.
- **Google ID token signatures are not checked.** The owner-login ID token comes directly from Google's token endpoint over TLS, so its signature is not verified, which OpenID Connect Core 3.1.3.7 allows. Its issuer, audience, nonce, expiry and `email_verified` claims are checked.
- **Rate limiting covers OAuth endpoints only.** The SDK's limits apply there. MCP tool calls are not rate limited.
