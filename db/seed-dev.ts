// Dane startowe do pracy lokalnej: szkoła, jej ustawienia, usługa i właściciel.
//
//   npm run db:seed -- twoj@adres.pl
//
// Potem zaloguj się tym adresem — po kliknięciu linku zobaczysz panel szkoły jako właściciel.
// Skrypt można uruchamiać wielokrotnie: niczego nie dubluje. Działa jako właściciel bazy (DATABASE_URL).
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const DEV_SCHOOL = { name: 'Szkoła Pierwszego Tańca', slug: 'szkola-pierwszego-tanca' };

export async function seedDev(databaseUrl: string, ownerEmail: string): Promise<{ organizationId: string; userId: string }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [DEV_SCHOOL.name, DEV_SCHOOL.slug],
    );
    const organizationId = org.rows[0]!.id;
    await client.query('INSERT INTO organization_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      organizationId,
    ]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = users.email
       RETURNING id`,
      [ownerEmail],
    );
    const userId = user.rows[0]!.id;
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [organizationId, userId],
    );
    // Usługa z domyślną długością lekcji (45 minut); cenę ustawimy przy płatnościach.
    await client.query(
      `INSERT INTO services (organization_id, name)
       SELECT $1, 'Lekcja pierwszego tańca'
       WHERE NOT EXISTS (SELECT 1 FROM services WHERE organization_id = $1)`,
      [organizationId],
    );
    await client.query('COMMIT');
    return { organizationId, userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

// Uruchomienie z linii poleceń.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  const email = process.argv[2];
  if (!url || !email) {
    console.error('Użycie: npm run db:seed -- twoj@adres.pl (wymaga DATABASE_URL, np. w pliku .env)');
    process.exit(1);
  }
  seedDev(url, email)
    .then(() => console.log(`Gotowe: ${DEV_SCHOOL.name}, właściciel ${email}. Zaloguj się tym adresem.`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
