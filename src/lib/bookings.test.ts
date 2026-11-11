// Rezerwacja i odwołanie lekcji z historią lekcji (zasady z docs/decyzje.md) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant().
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCredits,
  appTestDatabaseUrl,
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  createWeeklyHours,
  insertBooking,
} from '../../db/tests/helpers.ts';
import { bookLesson, BookingError, cancelBooking, listFreeSlots, type FirmContext } from './bookings';
import { createDb, type Database } from './db';
import { localTimeOf, localToInstant, timeToMinutes } from './local-time';

const TZ = 'Europe/Warsaw';
const DAY = '2027-01-11'; // poniedziałek, czas zimowy (UTC+1)
const at = (time: string, day = DAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04'); // tydzień przed DAY

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

type ClientStatus = 'new' | 'regular' | 'trusted';

interface Firm {
  orgId: string;
  ownerId: string;
  instructorId: string;
  serviceId: string;
  clientId: string;
  /** Właściciel szkoły. */
  staff: FirmContext;
  /** Para zalogowana na swoje konto klienta. */
  client: FirmContext;
}

/** Osobna szkoła na każdy test: instruktorka Ola (codziennie 16:00–21:00), lekcja 45 minut, jedna para. */
async function createFirm(options: { status?: ClientStatus; creditLimit?: number; credits?: number } = {}): Promise<Firm> {
  const orgId = await createOrg(owner);
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  const firm = { orgId, ownerId, instructorId, serviceId, staff: { organizationId: orgId, userId: ownerId } };
  const { clientId, ctx } = await addClient(firm, options);
  return { ...firm, clientId, client: ctx };
}

async function addClient(
  firm: { orgId: string; ownerId: string },
  options: { status?: ClientStatus; creditLimit?: number; credits?: number } = {},
): Promise<{ clientId: string; ctx: FirmContext }> {
  const userId = await createUser(owner);
  const clientId = await createClient(owner, firm.orgId, {
    userId,
    status: options.status ?? 'regular',
    creditLimit: options.creditLimit ?? 0,
  });
  if (options.credits) await addCredits(owner, firm.orgId, clientId, options.credits, firm.ownerId);
  return { clientId, ctx: { organizationId: firm.orgId, userId } };
}

function book(firm: Firm, time: string, options: { as?: FirmContext; clientId?: string; now?: Date } = {}) {
  return bookLesson(db, options.as ?? firm.client, {
    clientId: options.clientId ?? firm.clientId,
    instructorId: firm.instructorId,
    serviceId: firm.serviceId,
    startsAt: at(time),
    now: options.now ?? NOW,
  });
}

/** Kod odmowy (BookingError) albo opis innego wyniku. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof BookingError ? err.code : `inny błąd: ${String(err)}`;
  }
  return 'brak odmowy';
}

async function balance(clientId: string): Promise<number | undefined> {
  const { rows } = await owner.query<{ balance: number }>('SELECT balance FROM client_balances WHERE client_id = $1', [clientId]);
  return rows[0]?.balance;
}

async function bookingStatus(bookingId: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]);
  return rows[0]?.status;
}

async function bookingCount(orgId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1', [orgId]);
  return rows[0]?.n ?? -1;
}

/** Wstawia (jako właściciel bazy) rezerwację czekającą na płatność do podanej chwili. */
async function insertHold(firm: Firm, clientId: string, time: string, holdExpiresAt: Date): Promise<string> {
  const { rows } = await insertBooking(owner, {
    orgId: firm.orgId,
    instructorId: firm.instructorId,
    clientId,
    serviceId: firm.serviceId,
    start: at(time).toISOString(),
    end: new Date(at(time).getTime() + 45 * 60_000).toISOString(),
    status: 'pending_payment',
    holdExpiresAt: holdExpiresAt.toISOString(),
  });
  return rows[0]!.id;
}

describe('Rezerwacja lekcji: saldo i statusy klientów', () => {
  it('stały klient z lekcjami na koncie rezerwuje wolny termin, a saldo spada o koszt lekcji', async () => {
    const firm = await createFirm({ credits: 5 });
    const lesson = await book(firm, '16:45');

    expect(lesson.startsAt).toEqual(at('16:45'));
    expect(lesson.endsAt).toEqual(at('17:30'));
    expect(await bookingStatus(lesson.bookingId)).toBe('confirmed');
    expect(await balance(firm.clientId)).toBe(4);
  });

  it('rezerwacja blokuje kalendarz do końca lekcji plus przerwa (buffer_minutes)', async () => {
    const firm = await createFirm({ credits: 1 });
    await owner.query('UPDATE organization_settings SET buffer_minutes = 15 WHERE organization_id = $1', [firm.orgId]);
    const lesson = await book(firm, '16:00');

    const { rows } = await owner.query<{ blocks_until: Date }>('SELECT blocks_until FROM bookings WHERE id = $1', [
      lesson.bookingId,
    ]);
    expect(rows[0]?.blocks_until).toEqual(at('17:00'));
  });

  it('nowy klient bez płatności nie zarezerwuje lekcji (pierwsza lekcja tylko z płatnością online)', async () => {
    const firm = await createFirm({ status: 'new' });

    expect(await refusal(book(firm, '16:00'))).toBe('payment_required');
    expect(await bookingCount(firm.orgId)).toBe(0);
    expect(await balance(firm.clientId)).toBe(0);
  });

  it('nowy klient z opłaconymi lekcjami na koncie rezerwuje jak stały', async () => {
    const firm = await createFirm({ status: 'new', credits: 5 });
    await book(firm, '16:00');
    expect(await balance(firm.clientId)).toBe(4);
  });

  it('gdy pierwsza lekcja nie musi być płatna online, nowy klient bez lekcji na koncie dostaje zwykłą odmowę', async () => {
    const firm = await createFirm({ status: 'new' });
    await owner.query('UPDATE organization_settings SET first_lesson_prepaid = false WHERE organization_id = $1', [firm.orgId]);
    expect(await refusal(book(firm, '16:00'))).toBe('insufficient_credits');
  });

  it('stały klient bez lekcji na koncie nie zarezerwuje lekcji', async () => {
    const firm = await createFirm({ status: 'regular' });
    expect(await refusal(book(firm, '16:00'))).toBe('insufficient_credits');
    expect(await bookingCount(firm.orgId)).toBe(0);
  });

  it('zaufany klient rezerwuje bez lekcji na koncie do limitu (credit_limit), ale nie niżej', async () => {
    const firm = await createFirm({ status: 'trusted', creditLimit: 1 });

    await book(firm, '16:00');
    expect(await balance(firm.clientId)).toBe(-1);
    expect(await refusal(book(firm, '17:30'))).toBe('insufficient_credits');
    expect(await balance(firm.clientId)).toBe(-1);
  });

  it('dwie rezerwacje tej samej pary w tej samej chwili nie zejdą razem poniżej limitu', async () => {
    const firm = await createFirm({ credits: 1 });

    const results = await Promise.allSettled([book(firm, '16:00'), book(firm, '17:30')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect((rejected?.reason as BookingError).code).toBe('insufficient_credits');
    expect(await balance(firm.clientId)).toBe(0);
  });
});

describe('Rezerwacja lekcji: wolne terminy', () => {
  it('klient nie zarezerwuje godziny spoza wolnych terminów', async () => {
    const firm = await createFirm({ credits: 5 });
    expect(await refusal(book(firm, '16:10'))).toBe('slot_unavailable'); // poza siatką lekcji jedna po drugiej
    expect(await refusal(book(firm, '21:00'))).toBe('slot_unavailable'); // po godzinach pracy
    expect(await bookingCount(firm.orgId)).toBe(0);
  });

  it('klient nie zarezerwuje lekcji z krótszym wyprzedzeniem niż min_notice_minutes', async () => {
    const firm = await createFirm({ credits: 5 });
    // Wyprzedzenie 24 h: dzień wcześniej o 17:00 najwcześniejszy termin to 17:30.
    expect(await refusal(book(firm, '16:45', { now: at('17:00', '2027-01-10') }))).toBe('slot_unavailable');
    await expect(book(firm, '17:30', { now: at('17:00', '2027-01-10') })).resolves.toBeTruthy();
  });

  it('zarezerwowany termin nie jest już wolny dla innej pary', async () => {
    const firm = await createFirm({ credits: 5 });
    const other = await addClient(firm, { credits: 5 });
    await book(firm, '16:00');

    expect(await refusal(book(firm, '16:00', { as: other.ctx, clientId: other.clientId }))).toBe('slot_unavailable');
  });

  it('dwie pary klikające ten sam termin w tej samej chwili: przechodzi tylko jedna', async () => {
    const firm = await createFirm({ credits: 5 });
    const other = await addClient(firm, { credits: 5 });

    const results = await Promise.allSettled([
      book(firm, '16:00'),
      book(firm, '16:00', { as: other.ctx, clientId: other.clientId }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(['slot_taken', 'slot_unavailable']).toContain((rejected?.reason as BookingError).code);
    expect(await bookingCount(firm.orgId)).toBe(1);
  });

  it('szkoła wpisuje lekcję o dowolnej godzinie, byle nie nachodziła na inną', async () => {
    const firm = await createFirm({ credits: 5 });

    await expect(book(firm, '17:10', { as: firm.staff })).resolves.toBeTruthy(); // poza siatką
    await expect(book(firm, '22:00', { as: firm.staff })).resolves.toBeTruthy(); // po godzinach pracy
    expect(await refusal(book(firm, '17:30', { as: firm.staff }))).toBe('overlaps_booking'); // nachodzi na 17:10–17:55
  });

  it('klient nie zarezerwuje lekcji za inną parę', async () => {
    const firm = await createFirm({ credits: 5 });
    const other = await addClient(firm, { credits: 5 });
    expect(await refusal(book(firm, '16:00', { clientId: other.clientId }))).toBe('not_allowed');
  });

  it('osoba spoza firmy nie zarezerwuje lekcji', async () => {
    const firm = await createFirm({ credits: 5 });
    const stranger = { organizationId: firm.orgId, userId: await createUser(owner) };
    expect(await refusal(book(firm, '16:00', { as: stranger }))).toBe('not_allowed');
  });

  it('wygasła blokada na czas płatności zmienia się na expired i zwalnia termin przy kolejnej rezerwacji', async () => {
    const firm = await createFirm({ credits: 5 });
    const newcomer = await addClient(firm, { status: 'new' });
    const hold = await insertHold(firm, newcomer.clientId, '16:00', new Date(NOW.getTime() - 60_000));

    await book(firm, '16:00');
    expect(await bookingStatus(hold)).toBe('expired');
  });

  it('blokada na czas płatności przed wygaśnięciem trzyma termin', async () => {
    const firm = await createFirm({ credits: 5 });
    const newcomer = await addClient(firm, { status: 'new' });
    const hold = await insertHold(firm, newcomer.clientId, '16:00', new Date(NOW.getTime() + 30 * 60_000));

    expect(await refusal(book(firm, '16:00'))).toBe('slot_unavailable');
    expect(await bookingStatus(hold)).toBe('pending_payment');
  });

  it('wyłączona usługa nie przyjmuje rezerwacji', async () => {
    const firm = await createFirm({ credits: 5 });
    await owner.query('UPDATE services SET active = false WHERE id = $1', [firm.serviceId]);
    expect(await refusal(book(firm, '16:00'))).toBe('service_not_found');
  });
});

describe('Odwołanie lekcji', () => {
  const cancel = (firm: Firm, bookingId: string, now: Date, as: FirmContext = firm.client) =>
    cancelBooking(db, as, { bookingId, now });

  it('odwołanie wcześniej niż cancel_deadline_hours przed lekcją zwraca lekcję na konto', async () => {
    const firm = await createFirm({ credits: 1 });
    const { bookingId } = await book(firm, '16:00');
    expect(await balance(firm.clientId)).toBe(0);

    expect(await cancel(firm, bookingId, at('15:00', '2027-01-10'))).toEqual({ status: 'cancelled', refundedCredits: 1 });
    expect(await bookingStatus(bookingId)).toBe('cancelled');
    expect(await balance(firm.clientId)).toBe(1);
  });

  it('odwołanie dokładnie cancel_deadline_hours przed lekcją jeszcze zwraca lekcję', async () => {
    const firm = await createFirm({ credits: 1 });
    const { bookingId } = await book(firm, '16:00');
    expect(await cancel(firm, bookingId, at('16:00', '2027-01-10'))).toEqual({ status: 'cancelled', refundedCredits: 1 });
  });

  it('odwołanie po terminie: status late_cancelled i lekcja przepada', async () => {
    const firm = await createFirm({ credits: 1 });
    const { bookingId } = await book(firm, '16:00');

    expect(await cancel(firm, bookingId, at('16:01', '2027-01-10'))).toEqual({ status: 'late_cancelled', refundedCredits: 0 });
    expect(await bookingStatus(bookingId)).toBe('late_cancelled');
    expect(await balance(firm.clientId)).toBe(0);
  });

  it('historia lekcji zostaje: rezerwacja i zwrot to osobne wpisy, a drugie odwołanie niczego nie zwraca', async () => {
    const firm = await createFirm({ credits: 1 });
    const { bookingId } = await book(firm, '16:00');
    await cancel(firm, bookingId, at('09:00', '2027-01-05'));

    expect(await refusal(cancel(firm, bookingId, at('09:01', '2027-01-05')))).toBe('not_cancellable');
    const { rows } = await owner.query<{ reason: string; delta: number }>(
      'SELECT reason, delta FROM credit_entries WHERE booking_id = $1 ORDER BY created_at, reason',
      [bookingId],
    );
    expect(rows).toEqual([
      { reason: 'booking', delta: -1 },
      { reason: 'booking_refund', delta: 1 },
    ]);
    expect(await balance(firm.clientId)).toBe(1);
  });

  it('odwołana lekcja zwalnia termin dla innych', async () => {
    const firm = await createFirm({ credits: 1 });
    const other = await addClient(firm, { credits: 1 });
    const { bookingId } = await book(firm, '16:00');
    await cancel(firm, bookingId, at('09:00', '2027-01-05'));

    await expect(book(firm, '16:00', { as: other.ctx, clientId: other.clientId })).resolves.toBeTruthy();
  });

  it('nie można odwołać lekcji, która już się zaczęła', async () => {
    const firm = await createFirm({ credits: 1 });
    const { bookingId } = await book(firm, '16:00');
    expect(await refusal(cancel(firm, bookingId, at('16:00')))).toBe('already_started');
  });

  it('klient nie odwoła cudzej lekcji', async () => {
    const firm = await createFirm({ credits: 1 });
    const other = await addClient(firm);
    const { bookingId } = await book(firm, '16:00');

    expect(await refusal(cancel(firm, bookingId, at('09:00', '2027-01-05'), other.ctx))).toBe('booking_not_found');
    expect(await bookingStatus(bookingId)).toBe('confirmed');
  });

  it('szkoła odwołuje lekcję klienta według tych samych zasad i zapisuje, kto odwołał', async () => {
    const firm = await createFirm({ credits: 1 });
    const { bookingId } = await book(firm, '16:00');

    expect(await cancel(firm, bookingId, at('09:00', '2027-01-05'), firm.staff)).toEqual({
      status: 'cancelled',
      refundedCredits: 1,
    });
    const { rows } = await owner.query('SELECT cancelled_by FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0]).toEqual({ cancelled_by: firm.ownerId });
  });
});

describe('Lista wolnych terminów z bazy', () => {
  const times = (slots: { startsAt: Date }[]) => slots.map((s) => localTimeOf(s.startsAt.getTime(), TZ));
  const list = (firm: Firm, as: FirmContext = firm.client) =>
    listFreeSlots(db, as, { serviceId: firm.serviceId, from: DAY, to: DAY, now: NOW });

  it('lista pomija zajęte godziny, a następny termin zaczyna się zaraz po rezerwacji', async () => {
    const firm = await createFirm({ credits: 1 });
    await book(firm, '16:45');

    const slots = await list(firm);
    expect(times(slots)).toEqual(['16:00', '17:30', '18:15', '19:00', '19:45']);
    expect(new Set(slots.map((s) => s.instructorName))).toEqual(new Set(['Ola']));
  });

  it('wygasła blokada na czas płatności nie zajmuje terminu na liście', async () => {
    const firm = await createFirm();
    await insertHold(firm, firm.clientId, '16:00', new Date(NOW.getTime() - 60_000));
    expect(times(await list(firm))[0]).toBe('16:00');
  });

  it('terminy kilku instruktorów są na jednej liście, od najwcześniejszego', async () => {
    const firm = await createFirm();
    const kuba = await createInstructor(owner, firm.orgId, 'Kuba');
    await createWeeklyHours(owner, firm.orgId, kuba, '16:00', '17:00');

    const slots = await list(firm);
    expect(slots.slice(0, 2).map((s) => s.instructorName)).toEqual(['Kuba', 'Ola']);
    expect(times(slots.slice(0, 2))).toEqual(['16:00', '16:00']);
  });

  it('wyłączony instruktor nie ma wolnych terminów', async () => {
    const firm = await createFirm();
    await owner.query('UPDATE instructors SET active = false WHERE id = $1', [firm.instructorId]);
    expect(await list(firm)).toEqual([]);
  });

  it('osoba spoza firmy nie zobaczy wolnych terminów', async () => {
    const firm = await createFirm();
    const stranger = { organizationId: firm.orgId, userId: await createUser(owner) };
    expect(await refusal(list(firm, stranger))).toBe('not_allowed');
  });
});
