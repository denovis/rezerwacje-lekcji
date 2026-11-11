// Logowanie linkiem z maila (Better Auth).
//
// Konto (users) jest wspólne dla całego systemu; rola w firmie to osobna sprawa (memberships, clients).
// Pierwsze logowanie nowym adresem zakłada konto. Link działa raz i wygasa po MAGIC_LINK_MINUTES,
// a w bazie zapisujemy tylko skrót tokenu.
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { magicLink } from 'better-auth/plugins/magic-link';
import type { Database } from './db';

export const MAGIC_LINK_MINUTES = 15;

export interface AuthOptions {
  /** Baza widziana przez aplikację (rola app_user). */
  db: Database;
  /** Adres aplikacji, np. http://localhost:3000; z niego powstaje link w mailu. */
  baseURL: string;
  /** Klucz do podpisywania ciasteczek sesji, co najmniej 32 znaki. */
  secret: string;
  sendMagicLink: (to: string, url: string) => Promise<void>;
}

export function createAuth(options: AuthOptions) {
  return betterAuth({
    appName: 'Rezerwacje lekcji',
    baseURL: options.baseURL,
    secret: options.secret,
    database: { db: options.db, type: 'postgres' },
    // Tabele z migracji 0002. Nazwy kolumn tłumaczy CamelCasePlugin (emailVerified → email_verified).
    user: { modelName: 'users' },
    session: { modelName: 'auth_sessions' },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },
    // Identyfikatory to UUID: zwykłe nadaje baza (gen_random_uuid()), a te, które Better Auth
    // wylicza sam (np. blokada przy pierwszym logowaniu konta założonego przez szkołę), też mają format UUID.
    advanced: { database: { generateId: 'uuid' } },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_MINUTES * 60,
        storeToken: 'hashed',
        sendMagicLink: ({ email, url }) => options.sendMagicLink(email, url),
      }),
      // Ustawia ciasteczka w akcjach serwera Next.js; poza Next.js nic nie robi. Musi być ostatnia.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
