// Saldo lekcji jako historia wpisów i reguły zapisane w bazie.
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
let orgId: string;
let adminId: string;
let clientId: string;
let instructorId: string;
let serviceId: string;
let paymentId: string;
let bookingId: string;

beforeAll(async () => {
  pool = createPool();
  orgId = await createOrg(pool);
  adminId = await createUser(pool);
  await pool.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminId]);
  clientId = await createClient(pool, orgId, { status: 'regular' });
  instructorId = await createInstructor(pool, orgId);
  serviceId = await createService(pool, orgId);
});

afterAll(async () => {
  await pool.end();
});

const balance = (db: pg.Pool | pg.PoolClient, id: string) =>
  db.query<{ balance: number }>('SELECT balance FROM client_balances WHERE client_id = $1', [id]).then((r) => r.rows[0]?.balance);

describe('Saldo lekcji', () => {
  it('pakiet 5 lekcji i jedna rezerwacja dają saldo 4 (zapis przez aplikację)', async () => {
    const result = await asApp(pool, { orgId }, async (db) => {
      paymentId = (
        await db.query<{ id: string }>(
          `INSERT INTO payments (organization_id, client_id, method, status, amount_cents, credits, stripe_checkout_session_id, paid_at)
           VALUES ($1, $2, 'stripe', 'paid', 90000, 5, 'cs_test_pakiet', now()) RETURNING id`,
          [orgId, clientId],
        )
      ).rows[0]!.id;
      await db.query(
        "INSERT INTO credit_entries (organization_id, client_id, delta, reason, payment_id) VALUES ($1, $2, 5, 'purchase', $3)",
        [orgId, clientId, paymentId],
      );
      bookingId = (
        await insertBooking(db, {
          orgId, instructorId, clientId, serviceId,
          start: '2027-03-01T16:00:00+01:00', end: '2027-03-01T17:00:00+01:00',
        })
      ).rows[0]!.id;
      await db.query(
        "INSERT INTO credit_entries (organization_id, client_id, delta, reason, booking_id) VALUES ($1, $2, -1, 'booking', $3)",
        [orgId, clientId, bookingId],
      );
      return balance(db, clientId);
    });
    expect(result).toBe(4);
  });

  it('ta sama płatność nie dopisze lekcji drugi raz (powtórzony webhook)', async () => {
    const attempt = pool.query(
      "INSERT INTO credit_entries (organization_id, client_id, delta, reason, payment_id) VALUES ($1, $2, 5, 'purchase', $3)",
      [orgId, clientId, paymentId],
    );
    expect(await pgErrorCode(attempt)).toBe('23505');
  });

  it('jedna rezerwacja zdejmuje lekcję tylko raz i zwraca ją najwyżej raz', async () => {
    const charge = () =>
      pool.query(
        "INSERT INTO credit_entries (organization_id, client_id, delta, reason, booking_id) VALUES ($1, $2, -1, 'booking', $3)",
        [orgId, clientId, bookingId],
      );
    const refund = () =>
      pool.query(
        "INSERT INTO credit_entries (organization_id, client_id, delta, reason, booking_id) VALUES ($1, $2, 1, 'booking_refund', $3)",
        [orgId, clientId, bookingId],
      );
    expect(await pgErrorCode(charge())).toBe('23505');
    await refund();
    expect(await pgErrorCode(refund())).toBe('23505');
    expect(await balance(pool, clientId)).toBe(5);
  });

  it('aplikacja nie może zmieniać ani usuwać historii lekcji', async () => {
    expect(await pgErrorCode(asApp(pool, { orgId }, (db) => db.query('UPDATE credit_entries SET delta = 100')))).toBe('42501');
    expect(await pgErrorCode(asApp(pool, { orgId }, (db) => db.query('DELETE FROM credit_entries')))).toBe('42501');
  });

  it('ręczna korekta wymaga autora i notatki', async () => {
    const insert = (note: string | null, by: string | null) =>
      pool.query(
        "INSERT INTO credit_entries (organization_id, client_id, delta, reason, created_by, note) VALUES ($1, $2, 1, 'adjustment', $3, $4)",
        [orgId, clientId, by, note],
      );
    expect(await pgErrorCode(insert(null, adminId))).toBe('23514');
    expect(await pgErrorCode(insert('   ', adminId))).toBe('23514');
    expect(await pgErrorCode(insert('Gratis za polecenie', null))).toBe('23514');
    await expect(insert('Gratis za polecenie', adminId)).resolves.toBeTruthy();
  });
});

describe('Statusy klientów i płatności', () => {
  it('zejście poniżej zera (limit) jest dozwolone tylko dla zaufanych', async () => {
    expect(await pgErrorCode(createClient(pool, orgId, { status: 'regular', creditLimit: 2 }))).toBe('23514');
    expect(await pgErrorCode(createClient(pool, orgId, { status: 'new', creditLimit: 1 }))).toBe('23514');
    await expect(createClient(pool, orgId, { status: 'trusted', creditLimit: 2 })).resolves.toBeTruthy();
  });

  it('gotówkę zawsze przyjmuje konkretna osoba', async () => {
    const cash = (by: string | null) =>
      pool.query(
        `INSERT INTO payments (organization_id, client_id, method, status, amount_cents, credits, created_by, paid_at)
         VALUES ($1, $2, 'cash', 'paid', 20000, 1, $3, now())`,
        [orgId, clientId, by],
      );
    expect(await pgErrorCode(cash(null))).toBe('23514');
    await expect(cash(adminId)).resolves.toBeTruthy();
  });

  it('opłacona płatność musi mieć datę opłacenia', async () => {
    const attempt = pool.query(
      `INSERT INTO payments (organization_id, client_id, method, status, amount_cents, credits)
       VALUES ($1, $2, 'stripe', 'paid', 20000, 1)`,
      [orgId, clientId],
    );
    expect(await pgErrorCode(attempt)).toBe('23514');
  });

  it('blokada terminu na czas płatności trwa co najmniej 30 minut (minimum Stripe Checkout)', async () => {
    expect(
      await pgErrorCode(pool.query('UPDATE organization_settings SET payment_hold_minutes = 15 WHERE organization_id = $1', [orgId])),
    ).toBe('23514');
  });
});
