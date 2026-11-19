import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { Accounts } from './accounts.js';
import { fetchClientMetadata } from './auth/cimd.js';
import { InboxmuxAuthProvider, SCOPE } from './auth/provider.js';
import type { Config } from './config.js';
import type { Keyring } from './crypto.js';
import type { DB } from './db.js';
import { MailService } from './mail/service.js';
import { createMcpServer } from './mcp.js';
import { webRoutes } from './web/routes.js';

export interface AppOptions {
  fetchClientMetadata?: typeof fetchClientMetadata;
}

export function createApp(db: DB, config: Config, keyring: Keyring, options: AppOptions = {}) {
  const mcpUrl = `${config.PUBLIC_URL}/mcp`;
  const issuerUrl = new URL(config.PUBLIC_URL);
  const accounts = new Accounts(db, keyring, config);
  const mail = new MailService(db, accounts);
  const auth = new InboxmuxAuthProvider(
    db,
    mcpUrl,
    config.OWNER_EMAILS,
    config.ALLOWED_REDIRECT_ORIGINS,
    options.fetchClientMetadata ?? fetchClientMetadata,
  );

  const app: Express = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (issuerUrl.protocol === 'https:') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(cookieParser());

  const metadata = {
    ...createOAuthMetadata({ provider: auth, issuerUrl, scopesSupported: [SCOPE] }),
    client_id_metadata_document_supported: true,
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(metadata);
  });
  app.use(
    mcpAuthRouter({
      provider: auth,
      issuerUrl,
      resourceServerUrl: new URL(mcpUrl),
      scopesSupported: [SCOPE],
      resourceName: 'inboxmux',
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  app.use(webRoutes({ db, config, accounts, mail, auth }));

  const bearer = requireBearerAuth({
    verifier: auth,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl)),
    expectedResource: new URL(mcpUrl),
  });

  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const info = req.auth;
    const userId = info?.extra?.userId;
    if (!info || typeof userId !== 'number') {
      res.status(401).end();
      return;
    }
    const server = createMcpServer(db, mail, { userId, clientId: info.clientId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp', bearer, (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed; this server is stateless and only accepts POST',
        },
        id: null,
      });
  });

  return { app, accounts, mail, auth };
}
