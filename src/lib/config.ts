// Ustawienia aplikacji ze zmiennych środowiskowych (lokalnie z pliku .env, wzór w .env.example).

export interface AppConfig {
  /** Połączenie z bazą jako app_user — dzięki temu RLS działa dla każdego zapytania. */
  appDatabaseUrl: string;
  /** Adres aplikacji, np. http://localhost:3000. */
  baseUrl: string;
  /** Klucz do podpisywania ciasteczek sesji. */
  authSecret: string;
  /** Serwer SMTP; bez niego maile trafiają tylko do logu. */
  smtpUrl: string | undefined;
  /** Nadawca maili. */
  mailFrom: string;
  /** Klucz Stripe (sk_test_… lokalnie); bez niego płatności online są wyłączone. */
  stripeSecretKey: string | undefined;
  /** Sekret podpisu webhooków Stripe (whsec_…); bez niego webhook odrzuca zdarzenia. */
  stripeWebhookSecret: string | undefined;
}

export function readConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Brak zmiennej środowiskowej ${name}. Skopiuj .env.example do .env i uzupełnij.`);
    return value;
  };

  const appDatabaseUrl = required('APP_DATABASE_URL');
  const dbUser = decodeURIComponent(new URL(appDatabaseUrl).username);
  if (dbUser !== 'app_user') {
    // Inne konto (np. właściciel bazy) omija RLS — wtedy firmy widziałyby nawzajem swoje dane.
    throw new Error(`APP_DATABASE_URL musi używać konta app_user, a używa „${dbUser}”.`);
  }

  const authSecret = required('BETTER_AUTH_SECRET');
  if (authSecret.length < 32) throw new Error('BETTER_AUTH_SECRET musi mieć co najmniej 32 znaki.');

  const baseUrl = required('BETTER_AUTH_URL');
  const stripeSecretKey = env.STRIPE_SECRET_KEY || undefined;
  if (stripeSecretKey && !/^(sk|rk)_(test|live)_/.test(stripeSecretKey)) {
    throw new Error('STRIPE_SECRET_KEY musi zaczynać się od sk_test_ (klucz testowy) albo sk_live_.');
  }
  // Prawdziwe pieniądze tylko na serwerze z prawdziwym adresem, nigdy z komputera, na którym pracujemy.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
  if (stripeSecretKey && /_live_/.test(stripeSecretKey) && local) {
    throw new Error('Lokalnie używaj testowego klucza Stripe (sk_test_…), nie produkcyjnego.');
  }
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET || undefined;
  if (stripeWebhookSecret && !stripeWebhookSecret.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET musi zaczynać się od whsec_.');
  }

  return {
    appDatabaseUrl,
    baseUrl,
    authSecret,
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM || 'Rezerwacje lekcji <rezerwacje@localhost>',
    stripeSecretKey,
    stripeWebhookSecret,
  };
}
