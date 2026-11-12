// Płatności online (etap 4b): pierwsza lekcja z blokadą terminu, pakiet online, potwierdzenia ze Stripe.
// Baza prawdziwa (rola app_user, withTenant()); Stripe zastępują zdarzenia sesji płatności,
// a podpis webhooka sprawdza prawdziwa biblioteka Stripe na lokalnie podpisanym zdarzeniu.
import pg from 'pg';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appTestDatabaseUrl,
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  createWeeklyHours,
} from '../../db/tests/helpers.ts';
import { bookLesson, BookingError, listFreeSlots, type FirmContext } from './bookings';
import { createDb, type Database } from './db';
import { localTimeOf, localToInstant, timeToMinutes } from './local-time';
import {
  addPackage,
  cancelPendingBooking,
  checkoutRequestFor,
  handleCheckoutEvent,
  PaymentError,
  pendingCheckout,
  startPackagePurchase,
} from './payments';
import { checkoutParams, parseCheckoutEvent, type CheckoutEvent } from './stripe-gateway';
import { loadWeek } from './week';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11';
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04');
const MINUTE = 60_000;

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
  instructorId: string;
  serviceId: string;
  clientId: string;
  staff: FirmContext;
  client: FirmContext;
}

/** Szkoła z lekcją 45 min za 180 zł i nową parą bez lekcji na koncie (pierwsza lekcja płatna online). */
async function createFirm(): Promise<Firm> {
  const orgId = await createOrg(owner);
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  await owner.query('UPDATE services SET price_cents = 18000 WHERE id = $1', [serviceId]);
  const clientUser = await createUser(owner);
  const clientId = await createClient(owner, orgId, { userId: clientUser, status: 'new' });
  return {
    orgId,
    instructorId,
    serviceId,
    clientId,
    staff: { organizationId: orgId, userId: ownerId },
    client: { organizationId: orgId, userId: clientUser },
  };
}

function bookFirstLesson(firm: Firm, options: { payOnline?: boolean; as?: FirmContext } = {}) {
  return bookLesson(db, options.as ?? firm.client, {
    clientId: firm.clientId,
    instructorId: firm.instructorId,
    serviceId: firm.serviceId,
    startsAt: at('16:00'),
    payOnline: options.payOnline ?? true,
    now: NOW,
  });
}

/** Zdarzenie sesji płatności, tak jak po odczytaniu go z webhooka Stripe. */
function event(
  firm: Firm,
  paymentId: string,
  kind: CheckoutEvent['kind'],
  paymentStatus: 'paid' | 'unpaid' = kind === 'completed' || kind === 'async_succeeded' ? 'paid' : 'unpaid',
): CheckoutEvent {
  return {
    kind,
    session: {
      id: `cs_test_${paymentId}`,
      url: null,
      status: kind === 'expired' ? 'expired' : 'complete',
      paymentStatus,
      organizationId: firm.orgId,
      paymentId,
      paymentIntentId: `pi_test_${paymentId}`,
    },
  };
}

async function balance(clientId: string): Promise<number> {
  const { rows } = await owner.query<{ balance: number }>('SELECT balance FROM client_balances WHERE client_id = $1', [clientId]);
  return rows[0]?.balance ?? 0;
}

async function row<T>(sql: string, id: string): Promise<T | undefined> {
  return (await owner.query(sql, [id])).rows[0] as T | undefined;
}

async function freeAt(firm: Firm, now: Date): Promise<string[]> {
  const other = await createUser(owner);
  await createClient(owner, firm.orgId, { userId: other, status: 'regular' });
  const slots = await listFreeSlots(db, { organizationId: firm.orgId, userId: other }, {
    serviceId: firm.serviceId,
    from: MONDAY,
    to: MONDAY,
    now,
  });
  return slots.map((s) => localTimeOf(s.startsAt.getTime(), TZ));
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PaymentError || err instanceof BookingError) return err.code;
    return `inny błąd: ${String(err)}`;
  }
  return 'brak odmowy';
}

describe('Pierwsza lekcja nowej pary z płatnością online', () => {
  it('nowa para bez lekcji rezerwuje pierwszą lekcję z płatnością online: termin czeka na płatność przez payment_hold_minutes', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);

    expect(lesson.payment).toEqual({
      paymentId: expect.any(String),
      amountCents: 18000,
      holdExpiresAt: new Date(NOW.getTime() + 31 * MINUTE), // 30 minut z ustawień + minuta zapasu na sesję Stripe
    });
    expect(await row('SELECT status, payment_id FROM bookings WHERE id = $1', lesson.bookingId)).toEqual({
      status: 'pending_payment',
      payment_id: lesson.payment!.paymentId,
    });
    expect(await row('SELECT method, status, amount_cents, credits FROM payments WHERE id = $1', lesson.payment!.paymentId)).toEqual({
      method: 'stripe',
      status: 'pending',
      amount_cents: 18000,
      credits: 1,
    });
    expect(await balance(firm.clientId)).toBe(0);
  });

  it('bez ceny lekcji albo bez płatności online w szkole nowa para dostaje odmowę z informacją o płatności online', async () => {
    const firm = await createFirm();
    expect(await refusal(bookFirstLesson(firm, { payOnline: false }))).toBe('payment_required');
    await owner.query('UPDATE services SET price_cents = NULL WHERE id = $1', [firm.serviceId]);
    expect(await refusal(bookFirstLesson(firm))).toBe('payment_required');
  });

  it('szkoła nie wpisze nowej parze lekcji z płatnością online (przyjmuje wtedy gotówkę)', async () => {
    const firm = await createFirm();
    expect(await refusal(bookFirstLesson(firm, { as: firm.staff }))).toBe('payment_required');
  });

  it('termin czekający na płatność nie jest wolny dla innych, a po czasie blokady wraca do puli', async () => {
    const firm = await createFirm();
    await bookFirstLesson(firm);
    expect(await freeAt(firm, new Date(NOW.getTime() + 10 * MINUTE))).not.toContain('16:00');
    expect(await freeAt(firm, new Date(NOW.getTime() + 32 * MINUTE))).toContain('16:00');
  });

  it('zapłacona pierwsza lekcja zmienia się na zarezerwowaną, a saldo zostaje 0 (+1 z płatności, −1 za lekcję)', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const paymentId = lesson.payment!.paymentId;

    expect(await handleCheckoutEvent(db, event(firm, paymentId, 'completed'), NOW)).toBe('paid');
    expect(await row('SELECT status FROM bookings WHERE id = $1', lesson.bookingId)).toEqual({ status: 'confirmed' });
    expect(await row('SELECT status, stripe_checkout_session_id FROM payments WHERE id = $1', paymentId)).toEqual({
      status: 'paid',
      stripe_checkout_session_id: `cs_test_${paymentId}`,
    });
    const { rows } = await owner.query('SELECT reason, delta FROM credit_entries WHERE client_id = $1 ORDER BY delta DESC', [
      firm.clientId,
    ]);
    expect(rows).toEqual([
      { reason: 'purchase', delta: 1 },
      { reason: 'booking', delta: -1 },
    ]);
    expect(await balance(firm.clientId)).toBe(0);
  });

  it('powtórzone potwierdzenie płatności (webhook i powrót ze strony płatności) dopisuje lekcje tylko raz', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const paid = event(firm, lesson.payment!.paymentId, 'completed');
    expect(await handleCheckoutEvent(db, paid, NOW)).toBe('paid');
    expect(await handleCheckoutEvent(db, paid, NOW)).toBe('duplicate');
    expect(await handleCheckoutEvent(db, event(firm, lesson.payment!.paymentId, 'async_succeeded'), NOW)).toBe('duplicate');
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM credit_entries WHERE client_id = $1', [firm.clientId]);
    expect(rows[0]).toEqual({ n: 2 });
  });

  it('BLIK albo Przelewy24 w toku: lekcja czeka, a zapłata przychodzi osobnym potwierdzeniem', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const paymentId = lesson.payment!.paymentId;
    expect(await handleCheckoutEvent(db, event(firm, paymentId, 'completed', 'unpaid'), NOW)).toBe('waiting');
    expect(await row('SELECT status FROM bookings WHERE id = $1', lesson.bookingId)).toEqual({ status: 'pending_payment' });
    expect(await handleCheckoutEvent(db, event(firm, paymentId, 'async_succeeded'), NOW)).toBe('paid');
    expect(await row('SELECT status FROM bookings WHERE id = $1', lesson.bookingId)).toEqual({ status: 'confirmed' });
  });

  it('wygasła sesja płatności zwalnia termin, a nieudana płatność (np. odrzucony BLIK) też', async () => {
    for (const kind of ['expired', 'async_failed'] as const) {
      const firm = await createFirm();
      const lesson = await bookFirstLesson(firm);
      expect(await handleCheckoutEvent(db, event(firm, lesson.payment!.paymentId, kind), NOW)).toBe(
        kind === 'expired' ? 'expired' : 'failed',
      );
      expect(await row('SELECT status FROM bookings WHERE id = $1', lesson.bookingId)).toEqual({ status: 'expired' });
      expect(await freeAt(firm, NOW)).toContain('16:00');
    }
  });

  it('płatność, która dotrze po zwolnieniu terminu, trafia na konto jako lekcja do wykorzystania, a dziennik to odnotowuje', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const paymentId = lesson.payment!.paymentId;
    // Termin wrócił do puli (np. ktoś inny zarezerwował po czasie blokady).
    await owner.query("UPDATE bookings SET status = 'expired' WHERE id = $1", [lesson.bookingId]);

    expect(await handleCheckoutEvent(db, event(firm, paymentId, 'completed'), NOW)).toBe('late');
    expect(await balance(firm.clientId)).toBe(1);
    expect(await row('SELECT status FROM bookings WHERE id = $1', lesson.bookingId)).toEqual({ status: 'expired' });
    const { rows } = await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'payment.late' AND entity_id = $1", [
      paymentId,
    ]);
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('para rezygnuje z lekcji czekającej na płatność i termin od razu wraca do puli', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    expect(await pendingCheckout(db, firm.client, { bookingId: lesson.bookingId, now: NOW })).toEqual({
      paymentId: lesson.payment!.paymentId,
      sessionId: null,
    });
    await cancelPendingBooking(db, firm.client, { bookingId: lesson.bookingId, now: NOW });
    expect(await row('SELECT status FROM payments WHERE id = $1', lesson.payment!.paymentId)).toEqual({ status: 'expired' });
    expect(await freeAt(firm, NOW)).toContain('16:00');
    expect(await refusal(pendingCheckout(db, firm.client, { bookingId: lesson.bookingId, now: NOW }))).toBe('not_pending');
  });
});

describe('Płatności w kalendarzu pary', () => {
  it('nowa para bez lekcji widzi w kalendarzu kwotę za pierwszą lekcję, gdy szkoła ma płatności online', async () => {
    const firm = await createFirm();
    const online = await loadWeek(db, firm.client, { week: MONDAY, now: NOW, onlinePayments: true });
    expect(online?.client?.firstLessonPayment).toEqual({ amountLabel: expect.stringMatching(/^180,00\szł$/), holdMinutes: 30 });
    const offline = await loadWeek(db, firm.client, { week: MONDAY, now: NOW, onlinePayments: false });
    expect(offline?.client?.firstLessonPayment).toBeNull();
  });

  it('para widzi lekcję czekającą na płatność z godziną końca blokady, a po jej końcu jako nieopłaconą i wolną', async () => {
    const firm = await createFirm();
    await bookFirstLesson(firm);
    const during = await loadWeek(db, firm.client, { week: MONDAY, now: NOW, onlinePayments: true });
    expect(during?.lessons.map((l) => [l.statusLabel, l.blocksCalendar, l.pendingPayment?.untilLabel])).toEqual([
      ['czeka na płatność', true, '09:31'],
    ]);
    const after = await loadWeek(db, firm.client, { week: MONDAY, now: new Date(NOW.getTime() + 40 * MINUTE), onlinePayments: true });
    expect(after?.lessons.map((l) => [l.statusLabel, l.blocksCalendar, l.pendingPayment])).toEqual([
      ['nieopłacona w terminie', false, null],
    ]);
  });

  it('para widzi pakiety do kupienia online tylko wtedy, gdy szkoła ma płatności online', async () => {
    const firm = await createFirm();
    await addPackage(db, firm.staff, { name: 'Pakiet 5 lekcji', credits: 5, priceCents: 90000 });
    const online = await loadWeek(db, firm.client, { week: MONDAY, now: NOW, onlinePayments: true });
    expect(online?.onlinePackages.map((p) => [p.name, p.creditsLabel])).toEqual([['Pakiet 5 lekcji', '5 lekcji']]);
    expect((await loadWeek(db, firm.client, { week: MONDAY, now: NOW }))?.onlinePackages).toEqual([]);
  });
});

describe('Pakiet online i sesja płatności', () => {
  it('pakiet kupiony online dopisuje lekcje dopiero po potwierdzeniu płatności', async () => {
    const firm = await createFirm();
    const { id: packageId } = await addPackage(db, firm.staff, { name: 'Pakiet 5 lekcji', credits: 5, priceCents: 90000 });
    const { paymentId } = await startPackagePurchase(db, firm.client, { packageId });
    expect(await balance(firm.clientId)).toBe(0);
    expect(await handleCheckoutEvent(db, event(firm, paymentId, 'completed'), NOW)).toBe('paid');
    expect(await balance(firm.clientId)).toBe(5);
  });

  it('pakiet online kupuje tylko para na swoim koncie, a wyłączonego pakietu nie kupi', async () => {
    const firm = await createFirm();
    const { id: packageId } = await addPackage(db, firm.staff, { name: 'Pakiet', credits: 5, priceCents: 90000 });
    expect(await refusal(startPackagePurchase(db, firm.staff, { packageId }))).toBe('not_client');
    await owner.query('UPDATE packages SET active = false WHERE id = $1', [packageId]);
    expect(await refusal(startPackagePurchase(db, firm.client, { packageId }))).toBe('package_not_found');
  });

  it('sesja płatności ma kartę, BLIK i Przelewy24, kwotę w PLN i kończy się razem z blokadą terminu', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const request = await checkoutRequestFor(db, firm.client, { paymentId: lesson.payment!.paymentId });
    expect(request).toMatchObject({
      amountCents: 18000,
      currency: 'PLN',
      description: 'Lekcja pierwszego tańca, poniedziałek, 11 stycznia, 16:00',
      expiresAt: lesson.payment!.holdExpiresAt,
    });
    const params = checkoutParams({ ...request, successUrl: 'http://localhost/ok', cancelUrl: 'http://localhost/nie' });
    expect(params.allowed_payment_method_types).toEqual(['card', 'blik', 'p24']);
    expect(params.line_items?.[0]?.price_data).toMatchObject({ currency: 'pln', unit_amount: 18000 });
    expect(params.expires_at).toBe(Math.floor(lesson.payment!.holdExpiresAt.getTime() / 1000));
    expect(params.metadata).toEqual({ organizationId: firm.orgId, paymentId: lesson.payment!.paymentId });
  });

  it('para nie zapłaci za cudzą płatność ani nie zrezygnuje z cudzej lekcji', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const stranger = await createUser(owner);
    await createClient(owner, firm.orgId, { userId: stranger, status: 'new' });
    const ctx = { organizationId: firm.orgId, userId: stranger };
    expect(await refusal(checkoutRequestFor(db, ctx, { paymentId: lesson.payment!.paymentId }))).toBe('payment_not_found');
    expect(await refusal(cancelPendingBooking(db, ctx, { bookingId: lesson.bookingId, now: NOW }))).toBe('payment_not_found');
  });

  it('zdarzenie z sesją innej płatności albo bez danych firmy jest pomijane', async () => {
    const firm = await createFirm();
    const lesson = await bookFirstLesson(firm);
    const paymentId = lesson.payment!.paymentId;
    await owner.query("UPDATE payments SET stripe_checkout_session_id = 'cs_test_wlasciwa' WHERE id = $1", [paymentId]);
    expect(await handleCheckoutEvent(db, event(firm, paymentId, 'completed'), NOW)).toBe('ignored');
    const anonymous = event(firm, paymentId, 'completed');
    anonymous.session.organizationId = null;
    expect(await handleCheckoutEvent(db, anonymous, NOW)).toBe('ignored');
    expect(await balance(firm.clientId)).toBe(0);
  });
});

describe('Webhook Stripe', () => {
  it('webhook przyjmuje tylko zdarzenia z poprawnym podpisem Stripe', () => {
    const secret = `whsec_${'t'.repeat(32)}`;
    const body = JSON.stringify({
      id: 'evt_test',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          url: null,
          payment_intent: 'pi_test_1',
          metadata: { organizationId: 'org', paymentId: 'pay' },
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    expect(parseCheckoutEvent(body, signature, secret)).toEqual({
      kind: 'completed',
      session: {
        id: 'cs_test_1',
        url: null,
        status: 'complete',
        paymentStatus: 'paid',
        organizationId: 'org',
        paymentId: 'pay',
        paymentIntentId: 'pi_test_1',
      },
    });
    expect(() => parseCheckoutEvent(body, signature, `whsec_${'z'.repeat(32)}`)).toThrow();
    expect(() => parseCheckoutEvent(body.replace('paid', 'unpaid'), signature, secret)).toThrow();
  });
});
