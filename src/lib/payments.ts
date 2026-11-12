// Płatności i pakiety lekcji: pakiety w ustawieniach szkoły i gotówka przyjmowana w panelu.
// Płatności online (Stripe) dojdą w etapie 4b w tym samym module.
//
// Zasady (docs/decyzje.md, „Płatności”):
//  * Gotówkę przyjmuje szkoła (właściciel, admin): płatność 'cash' opłacona od razu, z osobą, która przyjęła,
//    kwotą i liczbą lekcji. Lekcje trafiają na konto wpisem 'purchase' (jedna płatność dopisuje lekcje raz).
//  * Pakiet to gotowa liczba lekcji i cena; przy sprzedaży kwotę można zmienić (np. rabat).
//  * Pakietów nie kasujemy: wyłączony pakiet nie jest do wyboru, a historia sprzedaży zostaje.
import { actorOf, type FirmContext } from './bookings';
import { withTenant, type Database, type Tx } from './db';
import type { Json } from './db-types';

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

async function audit(tx: Tx, ctx: FirmContext, action: string, entity: string, entityId: string, data: Json) {
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
