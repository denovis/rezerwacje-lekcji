// Wspólne obiekty serwera: baza i logowanie.
// Powstają przy pierwszym użyciu, raz na proces (także przy przeładowaniach w trybie deweloperskim).
import { createAuth, MAGIC_LINK_MINUTES, type Auth } from './auth';
import { readConfig } from './config';
import { createDb, type Database } from './db';
import { createMailer, magicLinkEmail } from './email';

interface ServerContext {
  db: Database;
  auth: Auth;
}

const store = globalThis as typeof globalThis & { __rezerwacjeLekcji?: ServerContext };

export function server(): ServerContext {
  if (!store.__rezerwacjeLekcji) {
    const config = readConfig();
    const db = createDb(config.appDatabaseUrl);
    const sendEmail = createMailer({ smtpUrl: config.smtpUrl, from: config.mailFrom });
    const auth = createAuth({
      db,
      baseURL: config.baseUrl,
      secret: config.authSecret,
      sendMagicLink: (to, url) => sendEmail(magicLinkEmail(to, url, MAGIC_LINK_MINUTES)),
    });
    store.__rezerwacjeLekcji = { db, auth };
  }
  return store.__rezerwacjeLekcji;
}
