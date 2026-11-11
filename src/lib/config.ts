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

  return {
    appDatabaseUrl,
    baseUrl: required('BETTER_AUTH_URL'),
    authSecret,
    smtpUrl: env.SMTP_URL || undefined,
    mailFrom: env.MAIL_FROM || 'Rezerwacje lekcji <rezerwacje@localhost>',
  };
}
