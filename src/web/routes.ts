import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { type Accounts, ALIAS_PATTERN } from '../accounts.js';
import type { InboxmuxAuthProvider, PendingAuthorization } from '../auth/provider.js';
import {
  createSession,
  csrfValid,
  destroySession,
  readSession,
  type Session,
  upsertUser,
} from '../auth/session.js';
import {
  completeUpstream,
  googleClient,
  googleEmailFromIdToken,
  googleRedirectUri,
  microsoftClient,
  microsoftRedirectUri,
  redirectToGoogle,
  redirectToMicrosoft,
} from '../auth/upstream.js';
import type { Config } from '../config.js';
import { type DB, peekPending, takePending } from '../db.js';
import { errorMessage, type MailService } from '../mail/service.js';
import { GmailProvider } from '../providers/gmail.js';
import { GraphProvider } from '../providers/graph.js';
import { ImapProvider } from '../providers/imap.js';
import { RefreshingToken } from '../providers/oauth.js';
import { IMAP_PRESETS } from '../providers/presets.js';
import { type Html, html, layout } from './html.js';

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

interface Deps {
  db: DB;
  config: Config;
  accounts: Accounts;
  mail: MailService;
  auth: InboxmuxAuthProvider;
}

export function webRoutes({ db, config, accounts, mail, auth }: Deps): Router {
  const router = Router();
  const owners = config.OWNER_EMAILS;
  const origin = new URL(config.PUBLIC_URL).origin;
  const safeNext = (next: unknown) => {
    if (typeof next !== 'string' || !next.startsWith('/')) return '/admin';
    const url = new URL(next, origin);
    return url.origin === origin ? `${url.pathname}${url.search}` : '/admin';
  };
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const csrf = (session: Session) => html`<input type="hidden" name="csrf" value="${session.csrf}">`;
  const header = (session: Session) => html`<div class="row" style="justify-content: space-between">
    <a href="/admin"><strong>inboxmux</strong></a>
    <form class="inline" method="post" action="/logout">${csrf(session)}<span class="muted">${session.email}</span>
      <button>Sign out</button></form></div>`;
  const fail = (res: Response, status: number, message: string) =>
    res
      .status(status)
      .type('html')
      .send(
        layout(
          'Error',
          html`<h1>Something went wrong</h1><p class="bad">${message}</p>
      <p><a href="/admin">Back</a></p>`,
        ),
      );

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    const session = readSession(db, req, owners);
    if (!session) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (req.method === 'POST' && !csrfValid(session, req)) {
      fail(res, 403, 'Invalid or missing CSRF token. Reload the page and try again.');
      return;
    }
    req.session = session;
    next();
  };

  router.get('/', (_req, res) => res.redirect(302, '/admin'));

  const signInLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.use(['/login', '/oauth'], signInLimit);

  router.get('/login', (req, res) => {
    redirectToGoogle(db, config, res, { kind: 'login', next: safeNext(req.query.next) });
  });

  router.post('/logout', requireOwner, (req, res) => {
    destroySession(db, req, res);
    res
      .type('html')
      .send(layout('Signed out', html`<h1>Signed out</h1><p><a href="/admin">Sign in again</a></p>`));
  });

  router.get('/oauth/google/callback', async (req, res) => {
    try {
      const { flow, nonce, tokens } = await completeUpstream(
        db,
        googleClient(config),
        googleRedirectUri(config),
        req.query,
      );
      if (flow.kind === 'login') {
        const email = googleEmailFromIdToken(tokens.id_token, config, nonce);
        if (!owners.includes(email)) return fail(res, 403, `${email} is not allowed to use this server.`);
        createSession(db, upsertUser(db, email), res);
        return res.redirect(302, flow.next);
      }
      if (flow.kind !== 'gmail') throw new Error('Unexpected sign-in flow');
      if (readSession(db, req, owners)?.userId !== flow.userId) {
        return fail(res, 401, 'Your session expired; sign in again.');
      }
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; try again.');
      const refreshToken = tokens.refresh_token;
      const gmail = new GmailProvider(
        new RefreshingToken(googleClient(config), refreshToken, () => undefined),
      );
      const { emailAddress } = await gmail.profile();
      saveOAuthAccount(flow, 'gmail', emailAddress, refreshToken);
      res.redirect(302, '/admin');
    } catch (err) {
      fail(res, 400, errorMessage(err));
    }
  });

  router.get('/oauth/microsoft/callback', async (req, res) => {
    try {
      const client = microsoftClient(config);
      const { flow, tokens } = await completeUpstream(db, client, microsoftRedirectUri(config), req.query);
      if (flow.kind !== 'graph') throw new Error('Unexpected sign-in flow');
      if (readSession(db, req, owners)?.userId !== flow.userId) {
        return fail(res, 401, 'Your session expired; sign in again.');
      }
      if (!tokens.refresh_token) throw new Error('Microsoft did not return a refresh token; try again.');
      let refreshToken = tokens.refresh_token;
      const graph = new GraphProvider(
        new RefreshingToken(client, refreshToken, (rotated) => {
          refreshToken = rotated;
        }),
      );
      const { email } = await graph.profile();
      saveOAuthAccount(flow, 'graph', email, refreshToken);
      res.redirect(302, '/admin');
    } catch (err) {
      fail(res, 400, errorMessage(err));
    }
  });

  function saveOAuthAccount(
    flow: { userId: number; alias: string; accountId?: number },
    provider: 'gmail' | 'graph',
    email: string,
    refreshToken: string,
  ) {
    if (flow.accountId) {
      const existing = accounts.get(flow.userId, flow.accountId);
      if (!existing) throw new Error('Account no longer exists');
      if (existing.email.toLowerCase() !== email.toLowerCase()) {
        throw new Error(`Signed in as ${email}, but this account is ${existing.email}`);
      }
      accounts.updateSecret(existing.id, { refreshToken });
    } else {
      accounts.create(flow.userId, {
        alias: flow.alias,
        provider,
        email,
        config: {},
        secret: { refreshToken },
      });
    }
  }

  router.get('/consent/:id', requireOwner, (req, res) => {
    const session = req.session as Session;
    const pending = peekPending<PendingAuthorization>(db, req.params.id as string, 'authorize');
    if (!pending)
      return fail(res, 400, 'This authorization request expired. Start again from your MCP client.');
    const redirect = new URL(pending.redirectUri);
    const destination =
      redirect.origin === 'null' ? `${redirect.protocol}//${redirect.host}` : redirect.origin;
    res.type('html').send(
      layout(
        'Authorize',
        html`<h1>Allow access to your mailboxes?</h1>
        <p><strong>${pending.clientName ?? 'An unnamed client'}</strong> wants read-only access to every mailbox
        connected to this inboxmux server.</p>
        <p>After you approve, you will be sent to <code>${destination}</code>.
        Only approve if you started this connection yourself.</p>
        <p class="muted">Client id: <code>${pending.clientId}</code></p>
        <form method="post" action="/consent/${req.params.id}" class="row">${csrf(session)}
          <button class="primary" name="decision" value="approve">Approve</button>
          <button name="decision" value="deny">Deny</button>
        </form>`,
        header(session),
      ),
    );
  });

  router.post('/consent/:id', requireOwner, (req, res) => {
    const session = req.session as Session;
    const pending = takePending<PendingAuthorization>(db, req.params.id as string, 'authorize');
    if (!pending)
      return fail(res, 400, 'This authorization request expired. Start again from your MCP client.');
    const target = new URL(pending.redirectUri);
    if (req.body.decision === 'approve') {
      target.searchParams.set('code', auth.issueCode(pending, session.userId));
    } else {
      target.searchParams.set('error', 'access_denied');
    }
    if (pending.state) target.searchParams.set('state', pending.state);
    res.redirect(302, target.href);
  });

  const renderAdmin = (session: Session, error?: string) => {
    const list = accounts.list(session.userId);
    const rows = list.map(
      (a) => html`<tr>
        <td><strong>${a.alias}</strong><br><span class="muted">${a.email}</span></td>
        <td>${a.provider}</td>
        <td>${a.status === 'ok' ? 'ok' : html`<span class="bad">${a.status}</span>`}
          ${a.lastError ? html`<br><span class="muted">${a.lastError}</span>` : ''}</td>
        <td class="row">
          <form class="inline" method="post" action="/admin/accounts/${a.id}/test">${csrf(session)}<button>Test</button></form>
          ${reauthControl(session, a.id, a.provider)}
          <form class="inline" method="post" action="/admin/accounts/${a.id}/delete">${csrf(session)}
            <button>Remove</button></form>
        </td></tr>`,
    );
    const presets = Object.entries(IMAP_PRESETS).map(
      ([key, p]) => html`<option value="${key}">${p.label} (${p.host})</option>`,
    );
    return layout(
      'Accounts',
      html`<h1>Mail accounts</h1>
      ${error ? html`<p class="bad">${error}</p>` : ''}
      ${
        list.length
          ? html`<table><thead><tr><th>Account</th><th>Provider</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
          : html`<p class="muted">No accounts yet.</p>`
      }
      <h2>Connect Gmail or Google Workspace</h2>
      <form method="post" action="/admin/accounts/gmail" class="row">${csrf(session)}
        <input name="alias" placeholder="alias, e.g. personal" required pattern="[a-z0-9][a-z0-9-]{0,31}">
        <button class="primary">Connect with Google</button></form>
      ${
        config.MICROSOFT_CLIENT_ID
          ? html`<h2>Connect Microsoft 365 or Outlook.com</h2>
        <form method="post" action="/admin/accounts/graph" class="row">${csrf(session)}
          <input name="alias" placeholder="alias, e.g. work" required pattern="[a-z0-9][a-z0-9-]{0,31}">
          <button class="primary">Connect with Microsoft</button></form>`
          : ''
      }
      <h2>Add an IMAP account</h2>
      <form method="post" action="/admin/accounts/imap">${csrf(session)}
        <fieldset>
          <label>Alias</label><input name="alias" required pattern="[a-z0-9][a-z0-9-]{0,31}">
          <label>Provider</label><select name="preset"><option value="">Other (enter host below)</option>${presets}</select>
          <label>Host (other only)</label><input name="host" placeholder="imap.example.com">
          <label>Port (other only)</label><input name="port" type="number" value="993">
          <label><input type="checkbox" name="secure" checked> TLS (port 993)</label>
          <label>Username</label><input name="user" required autocomplete="off">
          <label>Password or app password</label><input name="password" type="password" required autocomplete="new-password">
        </fieldset>
        <button class="primary">Test connection and save</button>
      </form>`,
      header(session),
    );
  };

  const reauthControl = (session: Session, id: number, provider: string): Html =>
    provider === 'imap'
      ? html`<form class="inline row" method="post" action="/admin/accounts/${id}/reauth">${csrf(session)}
          <input name="password" type="password" placeholder="new password" required autocomplete="new-password">
          <button>Update password</button></form>`
      : html`<form class="inline" method="post" action="/admin/accounts/${id}/reauth">${csrf(session)}
          <button>Reconnect</button></form>`;

  router.get('/admin', requireOwner, (req, res) => {
    res.type('html').send(renderAdmin(req.session as Session));
  });

  const aliasProblem = (session: Session, alias: string) => {
    if (!ALIAS_PATTERN.test(alias))
      return 'Alias must be 1-32 characters: lowercase letters, digits and dashes';
    if (accounts.list(session.userId).some((a) => a.alias === alias))
      return `Alias "${alias}" is already in use`;
    return undefined;
  };

  router.post('/admin/accounts/gmail', requireOwner, (req, res) => {
    const session = req.session as Session;
    const alias = String(req.body.alias ?? '');
    const problem = aliasProblem(session, alias);
    if (problem) return res.status(400).type('html').send(renderAdmin(session, problem));
    redirectToGoogle(db, config, res, { kind: 'gmail', userId: session.userId, alias });
  });

  router.post('/admin/accounts/graph', requireOwner, (req, res) => {
    const session = req.session as Session;
    const alias = String(req.body.alias ?? '');
    const problem = aliasProblem(session, alias);
    if (problem) return res.status(400).type('html').send(renderAdmin(session, problem));
    redirectToMicrosoft(db, config, res, { kind: 'graph', userId: session.userId, alias });
  });

  router.post('/admin/accounts/imap', requireOwner, async (req, res) => {
    const session = req.session as Session;
    try {
      const preset = IMAP_PRESETS[String(req.body.preset ?? '')];
      const imapConfig = {
        host: preset?.host ?? String(req.body.host ?? '').trim(),
        port: preset?.port ?? Number(req.body.port ?? 993),
        secure: preset?.secure ?? req.body.secure === 'on',
        user: String(req.body.user ?? '').trim(),
      };
      if (!imapConfig.host || !imapConfig.user) throw new Error('Host and username are required');
      const password = String(req.body.password ?? '');
      await new ImapProvider(imapConfig, password).verify();
      accounts.create(session.userId, {
        alias: String(req.body.alias ?? ''),
        provider: 'imap',
        email: imapConfig.user.includes('@') ? imapConfig.user : `${imapConfig.user}@${imapConfig.host}`,
        config: imapConfig,
        secret: { password },
      });
      res.redirect(303, '/admin');
    } catch (err) {
      res
        .status(400)
        .type('html')
        .send(renderAdmin(session, `Could not add account: ${errorMessage(err)}`));
    }
  });

  router.post('/admin/accounts/:id/reauth', requireOwner, async (req, res) => {
    const session = req.session as Session;
    const account = accounts.get(session.userId, Number(req.params.id));
    if (!account) return fail(res, 404, 'Account not found');
    const flow = { userId: session.userId, alias: account.alias, accountId: account.id };
    if (account.provider === 'gmail')
      return redirectToGoogle(db, config, res, { kind: 'gmail', ...flow }, account.email);
    if (account.provider === 'graph') {
      return redirectToMicrosoft(db, config, res, { kind: 'graph', ...flow }, account.email);
    }
    try {
      const password = String(req.body.password ?? '');
      await new ImapProvider(account.config as never, password).verify();
      accounts.updateSecret(account.id, { password });
      res.redirect(303, '/admin');
    } catch (err) {
      res
        .status(400)
        .type('html')
        .send(renderAdmin(session, `Could not update password: ${errorMessage(err)}`));
    }
  });

  router.post('/admin/accounts/:id/test', requireOwner, async (req, res) => {
    const session = req.session as Session;
    const account = accounts.get(session.userId, Number(req.params.id));
    if (!account) return fail(res, 404, 'Account not found');
    try {
      await mail.run(account, (p) => p.listFolders());
      res.redirect(303, '/admin');
    } catch (err) {
      res
        .status(400)
        .type('html')
        .send(renderAdmin(session, `${account.alias}: ${errorMessage(err)}`));
    }
  });

  router.post('/admin/accounts/:id/delete', requireOwner, (req, res) => {
    const session = req.session as Session;
    accounts.remove(session.userId, Number(req.params.id));
    res.redirect(303, '/admin');
  });

  return router;
}
