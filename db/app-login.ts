// Pozwala aplikacji logować się do bazy rolą app_user (RLS działa wtedy dla każdego zapytania).
//
// Rolę app_user tworzy migracja 0001 (bez prawa logowania). Ten skrypt nadaje jej prawo
// logowania i hasło wzięte z APP_DATABASE_URL. Uruchamia go właściciel bazy (DATABASE_URL).
// Hasło nie trafia do migracji, bo każde środowisko ma własne.
//
//   npm run db:app-login
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export async function enableAppLogin(ownerUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  if (decodeURIComponent(app.username) !== 'app_user') {
    throw new Error(`APP_DATABASE_URL musi używać użytkownika app_user, a używa „${app.username}”.`);
  }
  const password = decodeURIComponent(app.password);
  if (!password) throw new Error('APP_DATABASE_URL nie zawiera hasła.');

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`ALTER ROLE app_user WITH LOGIN PASSWORD ${owner.escapeLiteral(password)}`);
  } finally {
    await owner.end();
  }
}

// Uruchomienie z linii poleceń.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ownerUrl = process.env.DATABASE_URL;
  const appUrl = process.env.APP_DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    console.error('Ustaw DATABASE_URL (właściciel bazy) i APP_DATABASE_URL (aplikacja), np. w pliku .env.');
    process.exit(1);
  }
  enableAppLogin(ownerUrl, appUrl)
    .then(() => console.log('Rola app_user może się logować.'))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
