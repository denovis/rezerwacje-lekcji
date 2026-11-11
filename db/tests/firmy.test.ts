// Oddzielenie danych firm: RLS i klucze obce w obrębie firmy.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asApp,
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  insertBooking,
  pgErrorCode,
} from './helpers.ts';

let pool: pg.Pool;
let orgA: string;
let orgB: string;
let clientA: string;
let clientB: string;
let instructorA: string;
let instructorB: string;
let serviceA: string;
let userX: string; // instruktor w firmie A i jednocześnie klient w firmie B
let userY: string; // ktoś obcy w firmie B

beforeAll(async () => {
  pool = createPool();
  orgA = await createOrg(pool, 'Szkoła A');
  orgB = await createOrg(pool, 'Szkoła B');
  instructorA = await createInstructor(pool, orgA);
  instructorB = await createInstructor(pool, orgB);
  serviceA = await createService(pool, orgA);
  await createService(pool, orgB);
  clientA = await createClient(pool, orgA, { status: 'regular' });
  clientB = await createClient(pool, orgB, { status: 'regular' });

  userX = await createUser(pool);
  userY = await createUser(pool);
  await pool.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'instructor')", [orgA, userX]);
  await pool.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgB, userY]);
  await createClient(pool, orgB, { userId: userX });

  await insertBooking(pool, {
    orgId: orgA, instructorId: instructorA, clientId: clientA, serviceId: serviceA,
    start: '2027-02-01T16:00:00+01:00', end: '2027-02-01T17:00:00+01:00',
  });
});

afterAll(async () => {
  await pool.end();
});

describe('Oddzielenie danych firm', () => {
  it('aplikacja widzi tylko klientów, instruktorów i rezerwacje bieżącej firmy', async () => {
    const seen = await asApp(pool, { orgId: orgA }, async (db) => {
      const clients = await db.query<{ organization_id: string }>('SELECT organization_id FROM clients');
      const instructors = await db.query<{ organization_id: string }>('SELECT organization_id FROM instructors');
      const bookings = await db.query<{ organization_id: string }>('SELECT organization_id FROM bookings');
      return [...clients.rows, ...instructors.rows, ...bookings.rows].map((r) => r.organization_id);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([orgA]));
  });

  it('bez ustawionej firmy aplikacja nie widzi żadnych danych firm', async () => {
    const counts = await asApp(pool, {}, async (db) => {
      const tables = ['clients', 'instructors', 'services', 'bookings', 'payments', 'credit_entries', 'memberships'];
      const result: Record<string, number> = {};
      for (const t of tables) {
        result[t] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n ?? -1;
      }
      return result;
    });
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('nie da się zapisać klienta do innej firmy niż bieżąca', async () => {
    const attempt = asApp(pool, { orgId: orgA }, (db) =>
      db.query("INSERT INTO clients (organization_id, display_name) VALUES ($1, 'Obcy klient')", [orgB]),
    );
    expect(await pgErrorCode(attempt)).toBe('42501');
  });

  it('nie da się przenieść klienta do innej firmy', async () => {
    const attempt = asApp(pool, { orgId: orgA }, (db) =>
      db.query('UPDATE clients SET organization_id = $1 WHERE id = $2', [orgB, clientA]),
    );
    expect(await pgErrorCode(attempt)).toBe('42501');
  });

  it('nie da się zmienić klienta innej firmy (zmiana nie trafia w żaden wiersz)', async () => {
    const updated = await asApp(pool, { orgId: orgA }, (db) =>
      db.query("UPDATE clients SET display_name = 'Zmienione' WHERE id = $1", [clientB]),
    );
    expect(updated.rowCount).toBe(0);
    const { rows } = await pool.query<{ display_name: string }>('SELECT display_name FROM clients WHERE id = $1', [clientB]);
    expect(rows[0]?.display_name).toBe('Anna i Piotr');
  });

  it('rezerwacja nie może wskazać instruktora z innej firmy, nawet z pominięciem RLS', async () => {
    const attempt = insertBooking(pool, {
      orgId: orgA, instructorId: instructorB, clientId: clientA, serviceId: serviceA,
      start: '2027-02-02T16:00:00+01:00', end: '2027-02-02T17:00:00+01:00',
    });
    expect(await pgErrorCode(attempt)).toBe('23503');
  });

  it('saldo w widoku client_balances widać tylko dla bieżącej firmy', async () => {
    const orgs = await asApp(pool, { orgId: orgA }, async (db) =>
      (await db.query<{ organization_id: string }>('SELECT organization_id FROM client_balances')).rows.map(
        (r) => r.organization_id,
      ),
    );
    expect(orgs.length).toBeGreaterThan(0);
    expect(new Set(orgs)).toEqual(new Set([orgA]));
  });

  it('użytkownik widzi swoje role i profile klienta we wszystkich firmach, ale nie cudze', async () => {
    const seen = await asApp(pool, { userId: userX }, async (db) => ({
      memberships: (await db.query<{ user_id: string }>('SELECT user_id FROM memberships')).rows,
      clients: (await db.query<{ user_id: string; organization_id: string }>('SELECT user_id, organization_id FROM clients')).rows,
    }));
    expect(seen.memberships).toEqual([{ user_id: userX }]);
    expect(seen.clients).toEqual([{ user_id: userX, organization_id: orgB }]);
  });

  it('własny profil klienta w innej firmie można tylko odczytać, nie zmienić', async () => {
    const updated = await asApp(pool, { orgId: orgA, userId: userX }, (db) =>
      db.query("UPDATE clients SET display_name = 'Zmienione' WHERE user_id = $1 AND organization_id = $2", [userX, orgB]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it('dane firmy (np. po adresie strony) można odczytać bez kontekstu, ale zmienić tylko bieżącą firmę', async () => {
    const found = await asApp(pool, {}, async (db) =>
      (await db.query('SELECT id FROM organizations WHERE id = $1', [orgB])).rowCount,
    );
    expect(found).toBe(1);
    const updated = await asApp(pool, { orgId: orgA }, (db) =>
      db.query("UPDATE organizations SET name = 'Przejęta' WHERE id = $1", [orgB]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it('aplikacja nie może zakładać nowych firm (robi to platforma)', async () => {
    const attempt = asApp(pool, { orgId: orgA }, (db) =>
      db.query("INSERT INTO organizations (name, slug) VALUES ('Nowa', 'nowa-firma')"),
    );
    expect(await pgErrorCode(attempt)).toBe('42501');
  });
});
