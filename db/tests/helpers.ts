// Pomocnicze funkcje do testów bazy.
//
// Dwa sposoby dostępu:
//  * jako właściciel (owner) — bez RLS, do przygotowania danych testowych,
//  * jak aplikacja (asApp) — rola app_user + kontekst firmy i użytkownika, czyli z RLS.
import pg from 'pg';

// Połączenie administracyjne (do tworzenia bazy testowej). Domyślnie Postgres z docker-compose.yml.
export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
export const TEST_DB = 'rezerwacje_test';

export function testDatabaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

/** Baza testowa widziana tak jak przez aplikację: logowanie rolą app_user (z RLS). */
export function appTestDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.username = 'app_user';
  url.password = 'app_user';
  return url.toString();
}

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrl(), max: 5 });
}

/** Wykonuje fn w transakcji jako aplikacja: rola app_user, ustawiona firma i użytkownik. */
export async function asApp<T>(
  pool: pg.Pool,
  ctx: { orgId?: string | null; userId?: string | null },
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE app_user');
    await db.query("SELECT set_config('app.organization_id', $1, true)", [ctx.orgId ?? '']);
    await db.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId ?? '']);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

/** Kod błędu PostgreSQL z odrzuconej obietnicy (np. 23P01 = nakładanie się, 42501 = brak uprawnień). */
export async function pgErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? 'brak kodu';
  }
  return 'brak błędu';
}

// --- Dane testowe (tworzone jako właściciel, z pominięciem RLS) -------------------------------

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Identyfikator z pierwszego wiersza wyniku INSERT ... RETURNING id. */
function firstId(rows: { id: string }[]): string {
  const id = rows[0]?.id;
  if (!id) throw new Error('INSERT nie zwrócił id');
  return id;
}

export async function createOrg(pool: pg.Pool, name = 'Szkoła'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [name, `szkola-${unique()}`],
  );
  const id = firstId(rows);
  await pool.query('INSERT INTO organization_settings (organization_id) VALUES ($1)', [id]);
  return id;
}

export async function createUser(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `osoba-${unique()}@example.com`,
  ]);
  return firstId(rows);
}

export async function createInstructor(pool: pg.Pool, orgId: string, name = 'Instruktor'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO instructors (organization_id, name) VALUES ($1, $2) RETURNING id',
    [orgId, name],
  );
  return firstId(rows);
}

export async function createClient(
  pool: pg.Pool,
  orgId: string,
  opts: { userId?: string; status?: 'new' | 'regular' | 'trusted'; creditLimit?: number } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO clients (organization_id, user_id, display_name, status, credit_limit)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, opts.userId ?? null, 'Anna i Piotr', opts.status ?? 'new', opts.creditLimit ?? 0],
  );
  return firstId(rows);
}

export async function createService(pool: pg.Pool, orgId: string, minutes = 60): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO services (organization_id, name, duration_minutes, price_cents)
     VALUES ($1, 'Lekcja pierwszego tańca', $2, 20000) RETURNING id`,
    [orgId, minutes],
  );
  return firstId(rows);
}

/** Stałe godziny pracy instruktora we wszystkie dni tygodnia (domyślnie 16:00–21:00), obowiązujące od 2020 r. */
export async function createWeeklyHours(
  pool: pg.Pool,
  orgId: string,
  instructorId: string,
  from = '16:00',
  to = '21:00',
): Promise<void> {
  for (let weekday = 1; weekday <= 7; weekday++) {
    await pool.query(
      `INSERT INTO availability_rules (organization_id, instructor_id, weekday, start_time, end_time, valid_from)
       VALUES ($1, $2, $3, $4, $5, '2020-01-01')`,
      [orgId, instructorId, weekday, from, to],
    );
  }
}

/** Dopisuje lekcje na konto klienta ręczną korektą (z autorem i notatką). */
export async function addCredits(pool: pg.Pool, orgId: string, clientId: string, credits: number, byUserId: string): Promise<void> {
  await pool.query(
    `INSERT INTO credit_entries (organization_id, client_id, delta, reason, created_by, note)
     VALUES ($1, $2, $3, 'adjustment', $4, 'Lekcje do testów')`,
    [orgId, clientId, credits, byUserId],
  );
}

export interface BookingInput {
  orgId: string;
  instructorId: string;
  clientId: string;
  serviceId: string;
  start: string; // ISO z przesunięciem, np. '2026-12-05T16:00:00+01:00'
  end: string;
  blocksUntil?: string; // domyślnie = end (bez przerwy)
  status?: string;
  holdExpiresAt?: string | null;
}

export function insertBooking(db: pg.Pool | pg.PoolClient, b: BookingInput): Promise<pg.QueryResult<{ id: string }>> {
  const status = b.status ?? 'confirmed';
  return db.query<{ id: string }>(
    `INSERT INTO bookings (organization_id, instructor_id, client_id, service_id, starts_at, ends_at, blocks_until, status, hold_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      b.orgId,
      b.instructorId,
      b.clientId,
      b.serviceId,
      b.start,
      b.end,
      b.blocksUntil ?? b.end,
      status,
      // undefined = domyślnie (30 min dla pending_payment), null = celowo brak
      b.holdExpiresAt !== undefined
        ? b.holdExpiresAt
        : status === 'pending_payment'
          ? new Date(Date.now() + 30 * 60_000).toISOString()
          : null,
    ],
  );
}
