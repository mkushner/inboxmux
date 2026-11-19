#!/usr/bin/env node
import { Accounts } from './accounts.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { generateKey, Keyring } from './crypto.js';
import { openDb, purgeExpired } from './db.js';

const USAGE = `Usage: inboxmux <command>

Commands:
  serve        Start the HTTP server (default)
  gen-key      Print a new random encryption key
  rotate-key   Re-encrypt stored secrets with the first key in INBOXMUX_ENCRYPTION_KEY`;

async function main(command = 'serve') {
  switch (command) {
    case 'gen-key':
      console.log(generateKey());
      return;
    case 'rotate-key': {
      const config = loadConfig();
      const db = openDb(config.DATABASE_PATH);
      const changed = new Accounts(db, new Keyring(config.INBOXMUX_ENCRYPTION_KEY), config).reencryptAll();
      console.log(`Re-encrypted ${changed} account secret(s).`);
      return;
    }
    case 'serve': {
      const config = loadConfig();
      const db = openDb(config.DATABASE_PATH);
      const { app } = createApp(db, config, new Keyring(config.INBOXMUX_ENCRYPTION_KEY));
      setInterval(() => purgeExpired(db), 3_600_000).unref();
      const server = app.listen(config.PORT, () => {
        console.log(`inboxmux listening on :${config.PORT} (${config.PUBLIC_URL})`);
      });
      const shutdown = () => server.close(() => db.close());
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv[2]).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
