// Wspólne obiekty serwera: baza, logowanie i płatności online.
// Powstają przy pierwszym użyciu, raz na proces (także przy przeładowaniach w trybie deweloperskim).
import { createAuth, MAGIC_LINK_MINUTES, type Auth } from './auth';
import { readConfig } from './config';
import { createDb, type Database } from './db';
import { createMailer, magicLinkEmail } from './email';
import { stripeGateway, type PaymentGateway } from './stripe-gateway';

interface ServerContext {
  db: Database;
  auth: Auth;
  /** Adres aplikacji (BETTER_AUTH_URL), np. do powrotu ze strony płatności. */
  baseUrl: string;
  /** Płatności online; null, gdy nie ma klucza Stripe (STRIPE_SECRET_KEY). */
  payments: PaymentGateway | null;
  /** Sekret podpisu webhooków Stripe; null, gdy nie ustawiony. */
  stripeWebhookSecret: string | null;
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
    store.__rezerwacjeLekcji = {
      db,
      auth,
      baseUrl: config.baseUrl,
      payments: config.stripeSecretKey ? stripeGateway(config.stripeSecretKey) : null,
      stripeWebhookSecret: config.stripeWebhookSecret ?? null,
    };
  }
  return store.__rezerwacjeLekcji;
}
