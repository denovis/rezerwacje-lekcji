// Płatności i pakiety lekcji: pakiety w ustawieniach szkoły, gotówka przyjmowana w panelu
// i płatności online (Stripe Checkout: karta, BLIK, Przelewy24).
//
// Zasady (docs/decyzje.md, „Płatności”):
//  * Gotówkę przyjmuje szkoła (właściciel, admin): płatność 'cash' opłacona od razu, z osobą, która przyjęła,
//    kwotą i liczbą lekcji. Lekcje trafiają na konto wpisem 'purchase' (jedna płatność dopisuje lekcje raz).
//  * Pakiet to gotowa liczba lekcji i cena; przy sprzedaży kwotę można zmienić (np. rabat).
//  * Pakietów nie kasujemy: wyłączony pakiet nie jest do wyboru, a historia sprzedaży zostaje.
//  * Płatność online dopisuje lekcje najwyżej raz (status płatności i unikalny indeks w bazie), więc powtórzony
//    webhook i powrót ze strony płatności niczego nie zdublują.
//  * Pierwsza lekcja: po zapłacie rezerwacja zmienia się z „czeka na płatność” na zarezerwowaną, a na koncie
//    są dwa wpisy: +lekcja z płatności i −lekcja za rezerwację. Płatność po zwolnieniu terminu trafia na konto
//    jako lekcja do wykorzystania, a w dzienniku zostaje wpis payment.late.
import { actorOf, type FirmContext } from './bookings';
import { withTenant, type Database, type Tx } from './db';
import type { Json } from './db-types';
import { formatDay, formatTime } from './format';
import { addDays, isoWeekday, localDateOf } from './local-time';
import type { CheckoutEvent, CheckoutRequest, CheckoutSession } from './stripe-gateway';

const MESSAGES = {
  not_allowed: 'Płatności i pakiety prowadzi tylko właściciel albo administrator szkoły.',
  invalid_request: 'Nieprawidłowe dane formularza. Odśwież stronę i spróbuj ponownie.',
  name_required: 'Podaj nazwę pakietu, np. „Pakiet 5 lekcji”.',
  name_too_long: 'Nazwa może mieć najwyżej 80 znaków.',
  invalid_package_credits: 'Pakiet: od 1 do 100 lekcji.',
  invalid_package_price: 'Cena pakietu: od 0 do 100 000 zł.',
  package_not_found: 'Ten pakiet nie jest dostępny.',
  client_not_found: 'Nie znaleziono klienta.',
  invalid_credits: 'Wpłata: od 1 do 100 lekcji.',
  invalid_amount: 'Kwota: od 0 do 100 000 zł.',
  note_too_long: 'Notatka może mieć najwyżej 500 znaków.',
  not_client: 'Pakiet online kupuje para na swoim koncie klienta.',
  payment_not_found: 'Nie znaleziono płatności.',
  not_pending: 'Ta lekcja nie czeka już na płatność.',
  checkout_failed: 'Nie udało się otworzyć płatności online. Termin wrócił do puli; spróbuj jeszcze raz za chwilę.',
  checkout_closed: 'Czas na płatność minął i termin wrócił do puli. Zarezerwuj lekcję jeszcze raz.',
} as const;

export type PaymentErrorCode = keyof typeof MESSAGES;

/** Odmowa przy płatności albo pakiecie; komunikat po polsku można pokazać użytkownikowi. */
export class PaymentError extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(MESSAGES[code]);
    this.name = 'PaymentError';
  }
}

/** Najwyższa kwota jednej płatności albo pakietu: 100 000 zł w groszach. */
export const MAX_AMOUNT_CENTS = 10_000_000;
/** Najwięcej lekcji w jednym pakiecie albo jednej wpłacie. */
export const MAX_CREDITS = 100;

async function requireStaff(tx: Tx, ctx: FirmContext): Promise<void> {
  const actor = await actorOf(tx, ctx);
  if (!actor.isStaff) throw new PaymentError('not_allowed');
}

async function audit(
  tx: Tx,
  ctx: { organizationId: string; userId: string | null },
  action: string,
  entity: string,
  entityId: string,
  data: Json,
) {
  await tx
    .insertInto('auditLog')
    .values({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action, entity, entityId, data: JSON.stringify(data) })
    .execute();
}

const isAmount = (cents: number) => Number.isInteger(cents) && cents >= 0 && cents <= MAX_AMOUNT_CENTS;
const isCredits = (credits: number) => Number.isInteger(credits) && credits >= 1 && credits <= MAX_CREDITS;

// --- Pakiety ---------------------------------------------------------------------------------------

export interface PackageInput {
  name: string;
  credits: number;
  priceCents: number;
}

function cleanPackage(input: PackageInput): PackageInput {
  const name = (input.name ?? '').trim();
  if (!name) throw new PaymentError('name_required');
  if (name.length > 80) throw new PaymentError('name_too_long');
  if (!isCredits(input.credits)) throw new PaymentError('invalid_package_credits');
  if (!isAmount(input.priceCents)) throw new PaymentError('invalid_package_price');
  return { name, credits: input.credits, priceCents: input.priceCents };
}

/** Dodaje pakiet lekcji (np. 5 lekcji za 900 zł). */
export function addPackage(db: Database, ctx: FirmContext, input: PackageInput): Promise<{ id: string }> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const values = cleanPackage(input);
    const row = await tx
      .insertInto('packages')
      .values({ organizationId: ctx.organizationId, ...values })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(tx, ctx, 'package.added', 'packages', row.id, { ...values });
    return row;
  });
}

export interface PackageUpdate extends PackageInput {
  packageId: string;
  /** Wyłączony pakiet nie jest do wyboru; historia sprzedaży zostaje. */
  active: boolean;
}

/** Zmienia albo wyłącza pakiet. Wcześniejsze sprzedaże zostają z kwotą i liczbą lekcji z chwili sprzedaży. */
export function updatePackage(db: Database, ctx: FirmContext, input: PackageUpdate): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const values = cleanPackage(input);
    const result = await tx
      .updateTable('packages')
      .set({ ...values, active: input.active === true })
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.packageId)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new PaymentError('package_not_found');
    await audit(tx, ctx, 'package.updated', 'packages', input.packageId, { ...values, active: input.active === true });
  });
}

// --- Gotówka ---------------------------------------------------------------------------------------

export interface CashPaymentInput {
  clientId: string;
  /** Sprzedany pakiet; bez pakietu: pojedyncze lekcje (credits). */
  packageId?: string | null;
  /** Liczba lekcji, gdy wpłata nie jest za pakiet. */
  credits?: number | null;
  /** Kwota w groszach; przy pakiecie domyślnie jego cena. */
  amountCents?: number | null;
  note?: string | null;
  now?: Date;
}

/**
 * Przyjmuje gotówkę: opłacona płatność 'cash' z osobą, która przyjęła, i wpis 'purchase' z lekcjami na koncie.
 * Zwraca saldo po wpłacie.
 */
export function recordCashPayment(
  db: Database,
  ctx: FirmContext,
  input: CashPaymentInput,
): Promise<{ paymentId: string; credits: number; amountCents: number; balance: number }> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const note = (input.note ?? '').trim() || null;
    if (note && note.length > 500) throw new PaymentError('note_too_long');

    // Blokada wiersza klienta: wpłata i rezerwacja tej pary w tej samej chwili czekają na siebie.
    const client = await tx
      .selectFrom('clients')
      .select('id')
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.clientId)
      .forUpdate()
      .executeTakeFirst();
    if (!client) throw new PaymentError('client_not_found');

    let credits: number;
    let amountCents: number | null | undefined = input.amountCents;
    let packageId: string | null = null;
    if (input.packageId) {
      const pkg = await tx
        .selectFrom('packages')
        .select(['id', 'credits', 'priceCents'])
        .where('organizationId', '=', ctx.organizationId)
        .where('id', '=', input.packageId)
        .where('active', '=', true)
        .executeTakeFirst();
      if (!pkg) throw new PaymentError('package_not_found');
      credits = pkg.credits;
      packageId = pkg.id;
      amountCents ??= pkg.priceCents;
    } else {
      credits = input.credits ?? Number.NaN;
      if (!isCredits(credits)) throw new PaymentError('invalid_credits');
    }
    if (amountCents === null || amountCents === undefined || !isAmount(amountCents)) throw new PaymentError('invalid_amount');

    const payment = await tx
      .insertInto('payments')
      .values({
        organizationId: ctx.organizationId,
        clientId: client.id,
        method: 'cash',
        status: 'paid',
        amountCents,
        credits,
        packageId,
        createdBy: ctx.userId,
        note,
        paidAt: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('creditEntries')
      .values({
        organizationId: ctx.organizationId,
        clientId: client.id,
        delta: credits,
        reason: 'purchase',
        paymentId: payment.id,
        createdBy: ctx.userId,
        note,
      })
      .execute();
    await audit(tx, ctx, 'payment.cash_added', 'payments', payment.id, { clientId: client.id, credits, amountCents, packageId });

    const row = await tx.selectFrom('clientBalances').select('balance').where('clientId', '=', client.id).executeTakeFirst();
    return { paymentId: payment.id, credits, amountCents, balance: row?.balance ?? 0 };
  });
}

// --- Płatności online -------------------------------------------------------------------------------

const MINUTE = 60_000;
/** Ile czasu para ma na zapłatę za pakiet online (Stripe: co najmniej 30 minut). */
const PACKAGE_CHECKOUT_MINUTES = 60;

/** Kupno pakietu online przez parę: płatność czeka (pending), lekcje dopisze potwierdzenie ze Stripe. */
export function startPackagePurchase(
  db: Database,
  ctx: FirmContext,
  input: { packageId: string },
): Promise<{ paymentId: string }> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    if (!actor.ownClientId) throw new PaymentError('not_client');
    const pkg = await tx
      .selectFrom('packages')
      .select(['id', 'credits', 'priceCents'])
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.packageId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!pkg) throw new PaymentError('package_not_found');
    const payment = await tx
      .insertInto('payments')
      .values({
        organizationId: ctx.organizationId,
        clientId: actor.ownClientId,
        method: 'stripe',
        status: 'pending',
        amountCents: pkg.priceCents,
        credits: pkg.credits,
        packageId: pkg.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { paymentId: payment.id };
  });
}

/**
 * Dane do sesji płatności dla oczekującej płatności zalogowanej pary (bez adresów powrotu).
 * Pierwsza lekcja: płacić można do końca blokady terminu; pakiet: przez godzinę od założenia płatności.
 */
export function checkoutRequestFor(
  db: Database,
  ctx: FirmContext,
  input: { paymentId: string },
): Promise<Omit<CheckoutRequest, 'successUrl' | 'cancelUrl'> & { lessonWeek: string | null }> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    const row = await tx
      .selectFrom('payments as p')
      .innerJoin('organizations as o', 'o.id', 'p.organizationId')
      .leftJoin('packages as k', 'k.id', 'p.packageId')
      .leftJoin('bookings as b', 'b.paymentId', 'p.id')
      .leftJoin('services as s', 's.id', 'b.serviceId')
      .select([
        'p.id',
        'p.clientId',
        'p.status',
        'p.amountCents',
        'p.createdAt',
        'o.currency',
        'o.timezone',
        'k.name as packageName',
        'b.startsAt',
        'b.holdExpiresAt',
        's.name as serviceName',
      ])
      .where('p.organizationId', '=', ctx.organizationId)
      .where('p.id', '=', input.paymentId)
      .executeTakeFirst();
    if (!row || row.clientId !== actor.ownClientId) throw new PaymentError('payment_not_found');
    if (row.status !== 'pending') throw new PaymentError('not_pending');
    const user = await tx.selectFrom('users').select('email').where('id', '=', ctx.userId).executeTakeFirst();
    const description =
      row.startsAt && row.serviceName
        ? `${row.serviceName}, ${formatDay(row.startsAt, row.timezone)}, ${formatTime(row.startsAt, row.timezone)}`
        : (row.packageName ?? 'Lekcje');
    const expiresAt = row.holdExpiresAt ?? new Date(row.createdAt.getTime() + PACKAGE_CHECKOUT_MINUTES * MINUTE);
    // Po powrocie ze strony płatności kalendarz pokazuje tydzień opłaconej lekcji (poniedziałek, RRRR-MM-DD).
    const lessonDay = row.startsAt ? localDateOf(row.startsAt.getTime(), row.timezone) : null;
    const lessonWeek = lessonDay ? addDays(lessonDay, 1 - isoWeekday(lessonDay)) : null;
    return {
      organizationId: ctx.organizationId,
      paymentId: row.id,
      amountCents: row.amountCents,
      currency: row.currency,
      description,
      customerEmail: user?.email ?? null,
      expiresAt,
      lessonWeek,
    };
  });
}

/** Zapamiętuje sesję Stripe dla płatności (sprawdzenie po powrocie i zdarzenia z webhooka po niej trafiają). */
export function attachCheckout(db: Database, ctx: FirmContext, input: { paymentId: string; sessionId: string }): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await tx
      .updateTable('payments')
      .set({ stripeCheckoutSessionId: input.sessionId })
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.paymentId)
      .where('status', '=', 'pending')
      .execute();
  });
}

/** Płatność przepada (nieudana albo wygasła), a termin czekający na nią wraca do puli. */
async function releasePayment(tx: Tx, organizationId: string, paymentId: string, status: 'failed' | 'expired'): Promise<void> {
  await tx
    .updateTable('payments')
    .set({ status })
    .where('organizationId', '=', organizationId)
    .where('id', '=', paymentId)
    .where('status', '=', 'pending')
    .execute();
  await tx
    .updateTable('bookings')
    .set({ status: 'expired' })
    .where('organizationId', '=', organizationId)
    .where('paymentId', '=', paymentId)
    .where('status', '=', 'pending_payment')
    .execute();
}

/** Nie udało się założyć sesji płatności (np. Stripe nie odpowiada): płatność przepada, termin wraca do puli. */
export function abandonPayment(db: Database, ctx: FirmContext, input: { paymentId: string }): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    const payment = await tx
      .selectFrom('payments')
      .select('clientId')
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.paymentId)
      .executeTakeFirst();
    if (!payment || payment.clientId !== actor.ownClientId) throw new PaymentError('payment_not_found');
    await releasePayment(tx, ctx.organizationId, input.paymentId, 'failed');
  });
}

/** Lekcja zalogowanej pary, która jeszcze czeka na płatność (do wznowienia płatności albo rezygnacji). */
async function ownPendingBooking(tx: Tx, ctx: FirmContext, bookingId: string, now: Date) {
  const actor = await actorOf(tx, ctx);
  const row = await tx
    .selectFrom('bookings as b')
    .innerJoin('payments as p', 'p.id', 'b.paymentId')
    .select(['b.id', 'b.clientId', 'b.status', 'b.holdExpiresAt', 'p.id as paymentId', 'p.stripeCheckoutSessionId'])
    .where('b.organizationId', '=', ctx.organizationId)
    .where('b.id', '=', bookingId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.clientId !== actor.ownClientId) throw new PaymentError('payment_not_found');
  if (row.status !== 'pending_payment' || (row.holdExpiresAt !== null && row.holdExpiresAt <= now)) {
    throw new PaymentError('not_pending');
  }
  return row;
}

/** Sesja płatności, do której para może wrócić, żeby zapłacić za czekającą lekcję. */
export function pendingCheckout(
  db: Database,
  ctx: FirmContext,
  input: { bookingId: string; now?: Date },
): Promise<{ paymentId: string; sessionId: string | null }> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    const row = await ownPendingBooking(tx, ctx, input.bookingId, now);
    return { paymentId: row.paymentId, sessionId: row.stripeCheckoutSessionId };
  });
}

/** Para rezygnuje z lekcji czekającej na płatność: termin wraca do puli. Zwraca sesję Stripe do zamknięcia. */
export function cancelPendingBooking(
  db: Database,
  ctx: FirmContext,
  input: { bookingId: string; now?: Date },
): Promise<{ sessionId: string | null }> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    const row = await ownPendingBooking(tx, ctx, input.bookingId, now);
    await releasePayment(tx, ctx.organizationId, row.paymentId, 'expired');
    return { sessionId: row.stripeCheckoutSessionId };
  });
}

/** Wynik obsługi zdarzenia płatności (do testów i logu webhooka). */
export type CheckoutOutcome = 'paid' | 'late' | 'duplicate' | 'waiting' | 'expired' | 'failed' | 'ignored';

/**
 * Zdarzenie sesji płatności (webhook Stripe albo sprawdzenie po powrocie pary):
 *  * zapłacono — płatność opłacona, lekcje na konto (raz), czekająca lekcja zarezerwowana;
 *  * zapłacono po zwolnieniu terminu — lekcje zostają na koncie, w dzienniku payment.late;
 *  * BLIK albo Przelewy24 jeszcze w toku (completed, ale unpaid) — czekamy na kolejne zdarzenie;
 *  * sesja wygasła albo płatność się nie udała — płatność przepada, termin wraca do puli.
 * Firmę wskazują metadane sesji, które ustawia tylko nasz serwer (podpis webhooka sprawdza stripe-gateway).
 */
export function handleCheckoutEvent(db: Database, event: CheckoutEvent, now: Date = new Date()): Promise<CheckoutOutcome> {
  const { session } = event;
  const organizationId = session.organizationId;
  const paymentId = session.paymentId;
  if (!organizationId || !paymentId) return Promise.resolve('ignored');
  const ctx = { organizationId, userId: null };
  return withTenant(db, ctx, async (tx) => {
    const payment = await tx
      .selectFrom('payments')
      .select(['id', 'clientId', 'status', 'credits', 'stripeCheckoutSessionId'])
      .where('organizationId', '=', organizationId)
      .where('id', '=', paymentId)
      .where('method', '=', 'stripe')
      .forUpdate()
      .executeTakeFirst();
    if (!payment) return 'ignored';
    if (payment.stripeCheckoutSessionId !== null && payment.stripeCheckoutSessionId !== session.id) return 'ignored';

    const paid = event.kind === 'async_succeeded' || (event.kind === 'completed' && session.paymentStatus !== 'unpaid');
    if (event.kind === 'completed' && !paid) return 'waiting';
    if (!paid) {
      if (payment.status !== 'pending') return 'duplicate';
      const status = event.kind === 'expired' ? 'expired' : 'failed';
      await releasePayment(tx, organizationId, payment.id, status);
      return status;
    }
    if (payment.status === 'paid') return 'duplicate';

    await tx
      .updateTable('payments')
      .set({ status: 'paid', paidAt: now, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.paymentIntentId })
      .where('id', '=', payment.id)
      .execute();
    await tx
      .insertInto('creditEntries')
      .values({ organizationId, clientId: payment.clientId, delta: payment.credits, reason: 'purchase', paymentId: payment.id })
      .execute();
    await audit(tx, ctx, 'payment.paid', 'payments', payment.id, { credits: payment.credits, sessionId: session.id });

    const booking = await tx
      .selectFrom('bookings as b')
      .innerJoin('services as s', 's.id', 'b.serviceId')
      .select(['b.id', 'b.status', 's.creditCost'])
      .where('b.organizationId', '=', organizationId)
      .where('b.paymentId', '=', payment.id)
      .forUpdate()
      .executeTakeFirst();
    if (!booking) return 'paid';
    if (booking.status !== 'pending_payment') {
      // Termin wrócił już do puli: lekcja zostaje na koncie do wykorzystania.
      await audit(tx, ctx, 'payment.late', 'payments', payment.id, { bookingId: booking.id, bookingStatus: booking.status });
      return 'late';
    }
    await tx.updateTable('bookings').set({ status: 'confirmed' }).where('id', '=', booking.id).execute();
    await tx
      .insertInto('creditEntries')
      .values({ organizationId, clientId: payment.clientId, delta: -booking.creditCost, reason: 'booking', bookingId: booking.id })
      .execute();
    return 'paid';
  });
}

/** Sesja płatności należy do tej firmy (sprawdzenie po powrocie pary ze strony płatności). */
export function sessionBelongsTo(session: CheckoutSession, organizationId: string): boolean {
  return session.organizationId === organizationId && session.paymentId !== null;
}
