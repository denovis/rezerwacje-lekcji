// Dane startowe do pracy lokalnej: szkoła z ustawieniami, usługą, instruktorem z godzinami pracy,
// właściciel i para klientów z lekcjami na koncie.
//
//   npm run db:seed -- twoj@adres.pl [para@adres.pl]
//
// Potem zaloguj się adresem właściciela (grafik szkoły) albo pary (rezerwacja i odwołanie lekcji).
// Maile z linkami trafiają lokalnie do Mailpit (http://localhost:8025), więc adres pary może być zmyślony.
// Skrypt można uruchamiać wielokrotnie: niczego nie dubluje. Działa jako właściciel bazy (DATABASE_URL).
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const DEV_SCHOOL = {
  name: 'Szkoła Pierwszego Tańca',
  slug: 'szkola-pierwszego-tanca',
  instructor: 'Instruktor',
  /** Godziny pracy instruktora od poniedziałku (1) do piątku (5). */
  weekdays: [1, 2, 3, 4, 5],
  startTime: '16:00',
  endTime: '21:00',
};

export const DEV_CLIENT = {
  name: 'Anna i Piotr',
  email: 'para@example.com',
  /** Lekcje na koncie na start (ręczna korekta z notatką). */
  credits: 5,
};

export interface SeedResult {
  organizationId: string;
  userId: string;
  instructorId: string;
  clientId: string;
}

export async function seedDev(databaseUrl: string, ownerEmail: string, clientEmail = DEV_CLIENT.email): Promise<SeedResult> {
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
    const userId = await upsertUser(client, ownerEmail);
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

    // Instruktor ze stałymi godzinami pracy (tylko gdy szkoła nie ma jeszcze żadnego).
    let instructorId = (
      await client.query<{ id: string }>('SELECT id FROM instructors WHERE organization_id = $1 ORDER BY created_at LIMIT 1', [
        organizationId,
      ])
    ).rows[0]?.id;
    if (!instructorId) {
      instructorId = (
        await client.query<{ id: string }>('INSERT INTO instructors (organization_id, name) VALUES ($1, $2) RETURNING id', [
          organizationId,
          DEV_SCHOOL.instructor,
        ])
      ).rows[0]!.id;
      for (const weekday of DEV_SCHOOL.weekdays) {
        await client.query(
          `INSERT INTO availability_rules (organization_id, instructor_id, weekday, start_time, end_time)
           VALUES ($1, $2, $3, $4, $5)`,
          [organizationId, instructorId, weekday, DEV_SCHOOL.startTime, DEV_SCHOOL.endTime],
        );
      }
    }

    // Para klientów z kontem logowania i lekcjami na koncie (tylko przy pierwszym uruchomieniu).
    const clientUserId = await upsertUser(client, clientEmail);
    let clientId = (
      await client.query<{ id: string }>('SELECT id FROM clients WHERE organization_id = $1 AND user_id = $2', [
        organizationId,
        clientUserId,
      ])
    ).rows[0]?.id;
    if (!clientId) {
      clientId = (
        await client.query<{ id: string }>(
          `INSERT INTO clients (organization_id, user_id, display_name, email, status)
           VALUES ($1, $2, $3, $4, 'regular') RETURNING id`,
          [organizationId, clientUserId, DEV_CLIENT.name, clientEmail],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO credit_entries (organization_id, client_id, delta, reason, created_by, note)
         VALUES ($1, $2, $3, 'adjustment', $4, 'Lekcje startowe do pracy lokalnej')`,
        [organizationId, clientId, DEV_CLIENT.credits, userId],
      );
    }

    await client.query('COMMIT');
    return { organizationId, userId, instructorId, clientId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

async function upsertUser(client: pg.Client, email: string): Promise<string> {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = users.email
     RETURNING id`,
    [email],
  );
  return user.rows[0]!.id;
}

// Uruchomienie z linii poleceń.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  const [ownerEmail, clientEmail = DEV_CLIENT.email] = process.argv.slice(2);
  if (!url || !ownerEmail) {
    console.error('Użycie: npm run db:seed -- twoj@adres.pl [para@adres.pl] (wymaga DATABASE_URL, np. w pliku .env)');
    process.exit(1);
  }
  seedDev(url, ownerEmail, clientEmail)
    .then(() =>
      console.log(
        `Gotowe: ${DEV_SCHOOL.name}. Właściciel: ${ownerEmail}. Para klientów: ${clientEmail} ` +
          `(${DEV_CLIENT.credits} lekcji na koncie). Zaloguj się jednym z tych adresów.`,
      ),
    )
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
