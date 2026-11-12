// Klienci w panelu szkoły (zasady z docs/decyzje.md) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant().
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCredits,
  appTestDatabaseUrl,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  createWeeklyHours,
  insertBooking,
} from '../../db/tests/helpers.ts';
import { bookLesson, BookingError, type FirmContext } from './bookings';
import {
  addClient,
  adjustBalance,
  clientHistory,
  ClientError,
  clientsInDebt,
  loadClients,
  markNoShow,
  undoNoShow,
  updateClient,
} from './clients';
import { createDb, type Database } from './db';
import { listMyFirms } from './firms';
import { localToInstant, timeToMinutes } from './local-time';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11'; // czas zimowy (UTC+1)
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04');

let owner: pg.Pool;
let db: Database;

beforeAll(() => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

interface Firm {
  orgId: string;
  ownerId: string;
  instructorId: string;
  serviceId: string;
  staff: FirmContext;
}

/** Osobna szkoła na każdy test: właściciel, instruktorka (codziennie 16:00–21:00), lekcja 45 minut. */
async function createFirm(): Promise<Firm> {
  const orgId = await createOrg(owner);
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  return { orgId, ownerId, instructorId, serviceId, staff: { organizationId: orgId, userId: ownerId } };
}

const uniqueEmail = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/** Kod odmowy (ClientError) albo opis innego wyniku. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ClientError ? err.code : `inny błąd: ${String(err)}`;
  }
  return 'brak odmowy';
}

async function clientRow(id: string) {
  const { rows } = await owner.query<{ status: string; credit_limit: number; user_id: string | null; email: string | null }>(
    'SELECT status, credit_limit, user_id, email FROM clients WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function lesson(firm: Firm, clientId: string, time: string, status = 'confirmed'): Promise<string> {
  const { rows } = await insertBooking(owner, {
    orgId: firm.orgId,
    instructorId: firm.instructorId,
    clientId,
    serviceId: firm.serviceId,
    start: at(time).toISOString(),
    end: new Date(at(time).getTime() + 45 * 60_000).toISOString(),
    status,
  });
  return rows[0]!.id;
}

async function bookingStatus(id: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]);
  return rows[0]?.status;
}

describe('Dodawanie pary', () => {
  it('szkoła dodaje parę z adresem e-mail, a para loguje się tym adresem i widzi szkołę jako klient', async () => {
    const firm = await createFirm();
    const email = uniqueEmail('anna.piotr');
    const { id } = await addClient(db, firm.staff, {
      displayName: ' Anna i Piotr ',
      email,
      phone: '600 100 200',
      targetDate: '2027-06-19',
      notes: 'Walc angielski',
    });

    const row = await clientRow(id);
    expect(row).toMatchObject({ status: 'new', credit_limit: 0, email });
    const firms = await listMyFirms(db, row!.user_id!);
    expect(firms.find((f) => f.id === firm.orgId)?.roles).toEqual(['client']);
    const overview = await loadClients(db, firm.staff, NOW);
    expect(overview.clients).toEqual([
      expect.objectContaining({
        id,
        displayName: 'Anna i Piotr',
        phone: '600 100 200',
        targetDate: '2027-06-19',
        notes: 'Walc angielski',
        balance: 0,
        hasAccount: true,
      }),
    ]);
  });

  it('para z adresem, który ma już konto w systemie, dostaje to samo konto (bez dublowania)', async () => {
    const firm = await createFirm();
    const email = uniqueEmail('ewa.jan');
    const { rows } = await owner.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]);
    const { id } = await addClient(db, firm.staff, { displayName: 'Ewa i Jan', email: email.toUpperCase() });
    expect((await clientRow(id))?.user_id).toBe(rows[0]!.id);
  });

  it('para bez adresu e-mail nie ma konta, ale szkoła może wpisywać jej lekcje', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Kasia i Tomek', status: 'trusted' });
    expect((await clientRow(id))?.user_id).toBeNull();
    const booked = await bookLesson(db, firm.staff, {
      clientId: id,
      instructorId: firm.instructorId,
      serviceId: firm.serviceId,
      startsAt: at('16:00'),
      now: NOW,
    });
    expect(booked.bookingId).toBeTruthy();
  });

  it('adres e-mail pary jest unikalny w szkole (bez względu na wielkość liter)', async () => {
    const firm = await createFirm();
    const email = uniqueEmail('ola.adam');
    await addClient(db, firm.staff, { displayName: 'Ola i Adam', email });
    expect(await refusal(addClient(db, firm.staff, { displayName: 'Inna para', email: email.toUpperCase() }))).toBe('email_taken');
    expect(await refusal(addClient(db, firm.staff, { displayName: 'Ktoś', email: 'zły adres' }))).toBe('invalid_email');
    expect(await refusal(addClient(db, firm.staff, { displayName: '  ' }))).toBe('name_required');
    expect(await refusal(addClient(db, firm.staff, { displayName: 'Data', targetDate: '2027-02-30' }))).toBe('invalid_date');
  });
});

describe('Status pary i limit', () => {
  it('zmiana na zaufaną parę daje domyślny limit z ustawień firmy', async () => {
    const firm = await createFirm();
    await owner.query('UPDATE organization_settings SET default_trusted_credit_limit = 2 WHERE organization_id = $1', [firm.orgId]);
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr' });
    await updateClient(db, firm.staff, { clientId: id, displayName: 'Anna i Piotr', status: 'trusted' });
    expect(await clientRow(id)).toMatchObject({ status: 'trusted', credit_limit: 2 });
  });

  it('zaufana para rezerwuje bez lekcji na koncie do swojego limitu, ustawionego przez szkołę', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', status: 'trusted', creditLimit: 3 });
    const book = (time: string) =>
      bookLesson(db, firm.staff, { clientId: id, instructorId: firm.instructorId, serviceId: firm.serviceId, startsAt: at(time), now: NOW });
    await book('16:00');
    await book('16:45');
    await book('17:30');
    await expect(book('18:15')).rejects.toBeInstanceOf(BookingError);
  });

  it('limit zejścia poniżej zera ma tylko zaufana para: zmiana na stałą zeruje limit', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', status: 'trusted', creditLimit: 3 });
    await updateClient(db, firm.staff, { clientId: id, displayName: 'Anna i Piotr', status: 'regular', creditLimit: 3 });
    expect(await clientRow(id)).toMatchObject({ status: 'regular', credit_limit: 0 });
    expect(
      await refusal(updateClient(db, firm.staff, { clientId: id, displayName: 'Anna i Piotr', status: 'trusted', creditLimit: 21 })),
    ).toBe('invalid_limit');
  });

  it('zaufana para przy zmianie samych danych zachowuje swój limit', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', status: 'trusted', creditLimit: 4 });
    await updateClient(db, firm.staff, { clientId: id, displayName: 'Anna i Piotr Nowak', phone: '600', status: 'trusted' });
    expect(await clientRow(id)).toMatchObject({ status: 'trusted', credit_limit: 4 });
  });

  it('zmiana adresu e-mail łączy parę z kontem nowego adresu', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', email: uniqueEmail('stary') });
    const before = (await clientRow(id))?.user_id;
    const email = uniqueEmail('nowy');
    await updateClient(db, firm.staff, { clientId: id, displayName: 'Anna i Piotr', email, status: 'new' });
    const after = await clientRow(id);
    expect(after?.email).toBe(email);
    expect(after?.user_id).not.toBe(before);
  });

  it('każda zmiana pary trafia do dziennika z autorem', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr' });
    await updateClient(db, firm.staff, { clientId: id, displayName: 'Anna i Piotr', status: 'trusted' });
    const { rows } = await owner.query<{ action: string; actor_user_id: string; previous: string | null }>(
      "SELECT action, actor_user_id, data->>'previousStatus' AS previous FROM audit_log WHERE entity_id = $1 ORDER BY created_at",
      [id],
    );
    expect(rows).toEqual([
      { action: 'client.added', actor_user_id: firm.ownerId, previous: null },
      { action: 'client.updated', actor_user_id: firm.ownerId, previous: 'new' },
    ]);
  });
});

describe('Historia lekcji i korekta salda', () => {
  it('ręczna korekta salda dopisuje wpis z autorem i notatką, a historii nie zmienia', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr' });
    expect(await adjustBalance(db, firm.staff, { clientId: id, delta: 5, note: 'Gotówka 900 zł za 5 lekcji' })).toEqual({ balance: 5 });
    expect(await adjustBalance(db, firm.staff, { clientId: id, delta: -1, note: 'Pomyłka' })).toEqual({ balance: 4 });

    const { rows } = await owner.query<{ delta: number; reason: string; created_by: string; note: string }>(
      'SELECT delta, reason, created_by, note FROM credit_entries WHERE client_id = $1 ORDER BY created_at',
      [id],
    );
    expect(rows).toEqual([
      { delta: 5, reason: 'adjustment', created_by: firm.ownerId, note: 'Gotówka 900 zł za 5 lekcji' },
      { delta: -1, reason: 'adjustment', created_by: firm.ownerId, note: 'Pomyłka' },
    ]);
  });

  it('korekta salda wymaga notatki i liczby lekcji różnej od zera', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr' });
    expect(await refusal(adjustBalance(db, firm.staff, { clientId: id, delta: 2, note: '   ' }))).toBe('note_required');
    expect(await refusal(adjustBalance(db, firm.staff, { clientId: id, delta: 0, note: 'Nic' }))).toBe('adjustment_zero');
    expect(await refusal(adjustBalance(db, firm.staff, { clientId: id, delta: 1.5, note: 'Pół' }))).toBe('adjustment_zero');
    expect(await refusal(adjustBalance(db, firm.staff, { clientId: id, delta: 51, note: 'Dużo' }))).toBe('adjustment_too_big');
  });

  it('historia pary pokazuje wpisy od najnowszego, z lekcją, notatką, autorem i saldem po każdym wpisie', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', status: 'regular' });
    await adjustBalance(db, firm.staff, { clientId: id, delta: 2, note: 'Gotówka' });
    await bookLesson(db, firm.staff, { clientId: id, instructorId: firm.instructorId, serviceId: firm.serviceId, startsAt: at('16:00'), now: NOW });

    const history = await clientHistory(db, firm.staff, { clientId: id });
    expect(history.balance).toBe(1);
    expect(history.entries.map((e) => [e.reasonLabel, e.delta, e.balanceAfter, e.details])).toEqual([
      ['Rezerwacja lekcji', -1, 1, 'lekcja poniedziałek, 11 stycznia, 16:00–16:45'],
      ['Korekta', 2, 2, 'Gotówka'],
    ]);
    const { rows } = await owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [firm.ownerId]);
    expect(history.entries[1]?.author).toBe(rows[0]!.email);
  });

  it('lista osób na minusie pokazuje tylko pary z saldem poniżej zera, od największego długu', async () => {
    const firm = await createFirm();
    const make = async (name: string, balance: number) => {
      const { id } = await addClient(db, firm.staff, { displayName: name });
      if (balance !== 0) await addCredits(owner, firm.orgId, id, balance, firm.ownerId);
    };
    await make('Basia i Kuba', -1);
    await make('Anna i Piotr', 3);
    await make('Ewa i Jan', -2);
    await make('Ola i Adam', 0);
    const { clients } = await loadClients(db, firm.staff, NOW);
    expect(clientsInDebt(clients).map((c) => [c.displayName, c.balance])).toEqual([
      ['Ewa i Jan', -2],
      ['Basia i Kuba', -1],
    ]);
  });
});

describe('Nieobecność', () => {
  it('szkoła oznacza nieobecność od początku lekcji, a lekcja przepada (nic nie wraca na konto)', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', status: 'regular' });
    await adjustBalance(db, firm.staff, { clientId: id, delta: 1, note: 'Lekcja' });
    const booked = await bookLesson(db, firm.staff, {
      clientId: id,
      instructorId: firm.instructorId,
      serviceId: firm.serviceId,
      startsAt: at('16:00'),
      now: NOW,
    });

    expect(await refusal(markNoShow(db, firm.staff, { bookingId: booked.bookingId, now: at('15:59') }))).toBe('no_show_too_early');
    await markNoShow(db, firm.staff, { bookingId: booked.bookingId, now: at('16:10') });
    expect(await bookingStatus(booked.bookingId)).toBe('no_show');
    expect((await clientHistory(db, firm.staff, { clientId: id })).balance).toBe(0);
  });

  it('odwołanej lekcji nie można oznaczyć jako nieobecność', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr' });
    const bookingId = await lesson(firm, id, '16:00', 'cancelled');
    expect(await refusal(markNoShow(db, firm.staff, { bookingId, now: at('17:00') }))).toBe('no_show_not_possible');
  });

  it('pomyłkowo oznaczoną nieobecność można cofnąć: lekcja wraca do poprzedniego statusu', async () => {
    const firm = await createFirm();
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr' });
    const bookingId = await lesson(firm, id, '16:00');
    await markNoShow(db, firm.staff, { bookingId, now: at('17:00') });
    await undoNoShow(db, firm.staff, { bookingId });
    expect(await bookingStatus(bookingId)).toBe('confirmed');
    expect(await refusal(undoNoShow(db, firm.staff, { bookingId }))).toBe('not_no_show');
  });
});

describe('Kto prowadzi klientów', () => {
  it('klientów prowadzi tylko właściciel albo administrator: para i instruktor dostają odmowę', async () => {
    const firm = await createFirm();
    const email = uniqueEmail('para');
    const { id } = await addClient(db, firm.staff, { displayName: 'Anna i Piotr', email });
    const coupleUser = (await clientRow(id))!.user_id!;
    const instructorUser = await createUser(owner);
    await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'instructor')", [firm.orgId, instructorUser]);
    const bookingId = await lesson(firm, id, '16:00');

    for (const userId of [coupleUser, instructorUser]) {
      const ctx = { organizationId: firm.orgId, userId };
      expect(await refusal(loadClients(db, ctx, NOW))).toBe('not_allowed');
      expect(await refusal(addClient(db, ctx, { displayName: 'Obcy' }))).toBe('not_allowed');
      expect(await refusal(adjustBalance(db, ctx, { clientId: id, delta: 10, note: 'Sobie' }))).toBe('not_allowed');
      expect(await refusal(clientHistory(db, ctx, { clientId: id }))).toBe('not_allowed');
      expect(await refusal(markNoShow(db, ctx, { bookingId, now: at('17:00') }))).toBe('not_allowed');
    }

    const admin = await createUser(owner);
    await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [firm.orgId, admin]);
    expect(await adjustBalance(db, { organizationId: firm.orgId, userId: admin }, { clientId: id, delta: 1, note: 'Admin' })).toEqual({
      balance: 1,
    });
  });

  it('szkoła nie zobaczy ani nie zmieni klienta i lekcji innej firmy', async () => {
    const firm = await createFirm();
    const other = await createFirm();
    const { id } = await addClient(db, other.staff, { displayName: 'Obca para' });
    const bookingId = await lesson(other, id, '16:00');

    expect(await refusal(updateClient(db, firm.staff, { clientId: id, displayName: 'Przejęta', status: 'trusted' }))).toBe(
      'client_not_found',
    );
    expect(await refusal(adjustBalance(db, firm.staff, { clientId: id, delta: 5, note: 'Obce' }))).toBe('client_not_found');
    expect(await refusal(clientHistory(db, firm.staff, { clientId: id }))).toBe('client_not_found');
    expect(await refusal(markNoShow(db, firm.staff, { bookingId, now: at('17:00') }))).toBe('booking_not_found');
    expect((await loadClients(db, firm.staff, NOW)).clients).toEqual([]);
  });
});
