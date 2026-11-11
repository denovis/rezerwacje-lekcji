// Rezerwacje i odwołania lekcji razem z historią lekcji klienta (credit_entries).
//
// Zasady (docs/decyzje.md):
//  * Klient rezerwuje tylko wolny termin wyliczony z reguł grafiku (src/lib/slots.ts).
//    Szkoła (właściciel, admin) może wpisać lekcję o dowolnej godzinie, byle nie nachodziła na inną.
//  * Rezerwacja przechodzi, jeśli po zdjęciu lekcji saldo ≥ −limit. Sprawdzamy to w transakcji
//    z blokadą wiersza klienta, więc dwie rezerwacje tej samej pary naraz nie zejdą razem poniżej limitu.
//  * Nowy klient bez lekcji na koncie płaci za pierwszą lekcję online (płatności: etap 4).
//  * Przed wstawieniem rezerwacji wygasłe blokady na czas płatności zmieniamy na 'expired'.
//  * Odwołanie do cancel_deadline_hours przed lekcją zwraca lekcję (wpis booking_refund),
//    później status late_cancelled i lekcja przepada. Historii nie zmieniamy, tylko dopisujemy.
import { withTenant, type Database, type Tx } from './db';
import type { BookingStatus, ClientStatus, MemberRole } from './db-types';
import { addDays, isLocalDate, localDateOf, localToInstant } from './local-time';
import { freeSlots, type ScheduleSettings, type Slot } from './slots';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Statusy, które zajmują kalendarz (jak w ograniczeniu EXCLUDE w bazie). */
export const BLOCKING_STATUSES: BookingStatus[] = ['pending_payment', 'confirmed', 'completed', 'no_show'];

/** Role, które prowadzą grafik szkoły: rezerwują i odwołują lekcje za klientów. */
export const STAFF_ROLES: MemberRole[] = ['owner', 'admin'];

const MESSAGES = {
  not_allowed: 'Nie masz do tego dostępu.',
  client_not_found: 'Nie znaleziono klienta.',
  service_not_found: 'Ta usługa nie jest dostępna.',
  instructor_not_found: 'Ten instruktor nie przyjmuje rezerwacji.',
  slot_unavailable: 'Ten termin nie jest już wolny. Wybierz inny.',
  slot_taken: 'Ktoś właśnie zajął ten termin. Wybierz inny.',
  overlaps_booking: 'Ta godzina nachodzi na inną lekcję instruktora. Wybierz inną.',
  payment_required: 'Pierwszą lekcję trzeba opłacić online. Płatności online dodamy wkrótce — skontaktuj się ze szkołą.',
  insufficient_credits: 'Brak lekcji na koncie. Kup pakiet albo skontaktuj się ze szkołą.',
  booking_not_found: 'Nie znaleziono rezerwacji.',
  not_cancellable: 'Tej rezerwacji nie można już odwołać.',
  already_started: 'Lekcja już się zaczęła, więc nie można jej odwołać.',
  invalid_time: 'Podaj poprawną datę i godzinę.',
  invalid_request: 'Nieprawidłowe dane formularza. Odśwież stronę i spróbuj ponownie.',
} as const;

export type BookingErrorCode = keyof typeof MESSAGES;

export function bookingErrorMessage(code: BookingErrorCode): string {
  return MESSAGES[code];
}

/** Odmowa wynikająca z zasad rezerwacji; komunikat po polsku można pokazać użytkownikowi. */
export class BookingError extends Error {
  constructor(readonly code: BookingErrorCode) {
    super(MESSAGES[code]);
    this.name = 'BookingError';
  }
}

/** Wybrana firma i zalogowana osoba. */
export interface FirmContext {
  organizationId: string;
  userId: string;
}

export interface Actor {
  role: MemberRole | null;
  isStaff: boolean;
  /** Profil klienta zalogowanej osoby w tej firmie. */
  ownClientId: string | null;
}

/** Kim w wybranej firmie jest zalogowana osoba: rola w szkole i (albo) profil klienta. */
export async function actorOf(tx: Tx, ctx: FirmContext): Promise<Actor> {
  const membership = await tx
    .selectFrom('memberships')
    .select('role')
    .where('organizationId', '=', ctx.organizationId)
    .where('userId', '=', ctx.userId)
    .executeTakeFirst();
  const client = await tx
    .selectFrom('clients')
    .select('id')
    .where('organizationId', '=', ctx.organizationId)
    .where('userId', '=', ctx.userId)
    .executeTakeFirst();
  const role = membership?.role ?? null;
  return { role, isStaff: role !== null && STAFF_ROLES.includes(role), ownClientId: client?.id ?? null };
}

export interface FirmRules {
  timeZone: string;
  schedule: ScheduleSettings;
  cancelDeadlineHours: number;
  firstLessonPrepaid: boolean;
}

export async function loadFirmRules(tx: Tx, organizationId: string): Promise<FirmRules> {
  const row = await tx
    .selectFrom('organizations as o')
    .innerJoin('organizationSettings as s', 's.organizationId', 'o.id')
    .select([
      'o.timezone',
      's.backToBackSlots',
      's.slotStepMinutes',
      's.bufferMinutes',
      's.minGapMinutes',
      's.compactDays',
      's.minNoticeMinutes',
      's.maxAdvanceDays',
      's.cancelDeadlineHours',
      's.firstLessonPrepaid',
    ])
    .where('o.id', '=', organizationId)
    .executeTakeFirst();
  if (!row) throw new Error('Firma nie ma ustawień (organization_settings).');
  return {
    timeZone: row.timezone,
    schedule: {
      backToBackSlots: row.backToBackSlots,
      slotStepMinutes: row.slotStepMinutes,
      bufferMinutes: row.bufferMinutes,
      minGapMinutes: row.minGapMinutes,
      compactDays: row.compactDays,
      minNoticeMinutes: row.minNoticeMinutes,
      maxAdvanceDays: row.maxAdvanceDays,
    },
    cancelDeadlineHours: row.cancelDeadlineHours,
    firstLessonPrepaid: row.firstLessonPrepaid,
  };
}

/** Wolne terminy jednego instruktora: dane z bazy przekazane do czystej funkcji freeSlots. */
async function instructorSlots(
  tx: Tx,
  rules: FirmRules,
  instructorId: string,
  durationMinutes: number,
  from: string,
  to: string,
  now: Date,
): Promise<Slot[]> {
  const rangeStart = new Date(localToInstant(from, 0, rules.timeZone));
  const rangeEnd = new Date(localToInstant(addDays(to, 1), 0, rules.timeZone));

  const hours = await tx
    .selectFrom('availabilityRules')
    .select((eb) => [
      'weekday',
      'startTime',
      'endTime',
      // Typ date jako tekst RRRR-MM-DD, żeby nie zależał od strefy czasowej serwera aplikacji.
      eb.fn<string>('to_char', [eb.ref('validFrom'), eb.val('YYYY-MM-DD')]).as('validFrom'),
      eb.fn<string | null>('to_char', [eb.ref('validTo'), eb.val('YYYY-MM-DD')]).as('validTo'),
    ])
    .where('instructorId', '=', instructorId)
    .where('active', '=', true) // wyłączone: zastąpione nowymi godzinami pracy
    .execute();
  const exceptions = await tx
    .selectFrom('availabilityExceptions')
    .select(['kind', 'startsAt', 'endsAt'])
    .where('instructorId', '=', instructorId)
    .where('active', '=', true) // wyłączone: odwołany urlop albo dodatkowe godziny
    .where('endsAt', '>', rangeStart)
    .where('startsAt', '<', rangeEnd)
    .execute();
  // Rezerwacje stykające się z zakresem też są potrzebne (przyklejanie, minimalna przerwa).
  const busy = await tx
    .selectFrom('bookings')
    .select(['startsAt', 'blocksUntil'])
    .where('instructorId', '=', instructorId)
    .where('status', 'in', BLOCKING_STATUSES)
    .where((eb) => eb.or([eb('status', '!=', 'pending_payment'), eb('holdExpiresAt', '>', now)]))
    .where('blocksUntil', '>=', rangeStart)
    .where('startsAt', '<=', rangeEnd)
    .execute();

  return freeSlots({
    timeZone: rules.timeZone,
    now,
    from,
    to,
    durationMinutes,
    settings: rules.schedule,
    hours,
    exceptions,
    busy,
  });
}

export interface OpenSlot {
  instructorId: string;
  instructorName: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ListFreeSlotsInput {
  serviceId: string;
  /** Pierwszy i ostatni dzień (lokalnie, RRRR-MM-DD, włącznie). */
  from: string;
  to: string;
  /** Tylko ten instruktor; domyślnie wszyscy aktywni. */
  instructorId?: string;
  now?: Date;
}

/** Wolne terminy wszystkich aktywnych instruktorów (albo jednego) dla wybranej usługi. */
export function listFreeSlots(db: Database, ctx: FirmContext, input: ListFreeSlotsInput): Promise<OpenSlot[]> {
  if (!isLocalDate(input.from) || !isLocalDate(input.to)) throw new Error('Zakres dni musi mieć format RRRR-MM-DD.');
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    if (actor.role === null && actor.ownClientId === null) throw new BookingError('not_allowed');

    const rules = await loadFirmRules(tx, ctx.organizationId);
    const service = await tx
      .selectFrom('services')
      .select(['id', 'durationMinutes'])
      .where('id', '=', input.serviceId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!service) throw new BookingError('service_not_found');

    let instructorsQuery = tx.selectFrom('instructors').select(['id', 'name']).where('active', '=', true);
    if (input.instructorId) instructorsQuery = instructorsQuery.where('id', '=', input.instructorId);
    const instructors = await instructorsQuery.orderBy('name').execute();

    const result: OpenSlot[] = [];
    for (const instructor of instructors) {
      const slots = await instructorSlots(tx, rules, instructor.id, service.durationMinutes, input.from, input.to, now);
      for (const slot of slots) {
        result.push({ instructorId: instructor.id, instructorName: instructor.name, startsAt: slot.startsAt, endsAt: slot.endsAt });
      }
    }
    return result.sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.instructorName.localeCompare(b.instructorName, 'pl'),
    );
  });
}

export interface BookLessonInput {
  clientId: string;
  instructorId: string;
  serviceId: string;
  startsAt: Date;
  now?: Date;
}

export interface BookedLesson {
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Rezerwuje lekcję i zdejmuje ją z konta klienta (wpis 'booking').
 * Klient rezerwuje dla siebie i tylko wolny termin; szkoła dla dowolnego klienta i o dowolnej godzinie.
 * Odmowy zgodne z zasadami rzucają BookingError z kodem.
 */
export async function bookLesson(db: Database, ctx: FirmContext, input: BookLessonInput): Promise<BookedLesson> {
  const now = input.now ?? new Date();
  let byStaff = false;
  try {
    return await withTenant(db, ctx, async (tx) => {
      const actor = await actorOf(tx, ctx);
      byStaff = actor.isStaff;
      if (!actor.isStaff && actor.ownClientId !== input.clientId) throw new BookingError('not_allowed');

      // Blokada wiersza klienta do końca transakcji: kolejna rezerwacja tej pary czeka i widzi już nowe saldo.
      const client = await tx
        .selectFrom('clients')
        .select(['id', 'status', 'creditLimit'])
        .where('organizationId', '=', ctx.organizationId) // RLS pokazuje też własne profile klienta w innych firmach
        .where('id', '=', input.clientId)
        .forUpdate()
        .executeTakeFirst();
      if (!client) throw new BookingError('client_not_found');

      const rules = await loadFirmRules(tx, ctx.organizationId);
      const service = await tx
        .selectFrom('services')
        .select(['id', 'durationMinutes', 'creditCost'])
        .where('id', '=', input.serviceId)
        .where('active', '=', true)
        .executeTakeFirst();
      if (!service) throw new BookingError('service_not_found');
      const instructor = await tx
        .selectFrom('instructors')
        .select('id')
        .where('id', '=', input.instructorId)
        .where('active', '=', true)
        .executeTakeFirst();
      if (!instructor) throw new BookingError('instructor_not_found');

      // Ograniczenie EXCLUDE nie może używać now(), więc wygasłe blokady zwalniamy tutaj.
      await tx
        .updateTable('bookings')
        .set({ status: 'expired' })
        .where('instructorId', '=', instructor.id)
        .where('status', '=', 'pending_payment')
        .where('holdExpiresAt', '<=', now)
        .execute();

      const startsAt = input.startsAt;
      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * MINUTE);
      const blocksUntil = new Date(endsAt.getTime() + rules.schedule.bufferMinutes * MINUTE);

      if (!actor.isStaff) {
        const day = localDateOf(startsAt.getTime(), rules.timeZone);
        const slots = await instructorSlots(tx, rules, instructor.id, service.durationMinutes, day, day, now);
        if (!slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())) {
          throw new BookingError('slot_unavailable');
        }
      }

      const balance = await balanceOf(tx, client.id);
      if (balance - service.creditCost < -client.creditLimit) {
        throw new BookingError(
          needsOnlinePayment(client.status, rules.firstLessonPrepaid) ? 'payment_required' : 'insufficient_credits',
        );
      }

      const booking = await tx
        .insertInto('bookings')
        .values({
          organizationId: ctx.organizationId,
          instructorId: instructor.id,
          clientId: client.id,
          serviceId: service.id,
          startsAt,
          endsAt,
          blocksUntil,
          status: 'confirmed',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('creditEntries')
        .values({
          organizationId: ctx.organizationId,
          clientId: client.id,
          delta: -service.creditCost,
          reason: 'booking',
          bookingId: booking.id,
          createdBy: ctx.userId,
        })
        .execute();

      return { bookingId: booking.id, startsAt, endsAt };
    });
  } catch (err) {
    // 23P01: ograniczenie EXCLUDE — lekcja nachodzi na inną. Klient wybiera z listy wolnych terminów,
    // więc u niego to znaczy, że ktoś zajął termin w tej samej chwili. Szkoła wpisuje godzinę ręcznie.
    if ((err as { code?: unknown }).code === '23P01') throw new BookingError(byStaff ? 'overlaps_booking' : 'slot_taken');
    throw err;
  }
}

/** Nowy klient bez lekcji na koncie płaci za pierwszą lekcję online (ustawienie first_lesson_prepaid). */
function needsOnlinePayment(status: ClientStatus, firstLessonPrepaid: boolean): boolean {
  return status === 'new' && firstLessonPrepaid;
}

async function balanceOf(tx: Tx, clientId: string): Promise<number> {
  const row = await tx.selectFrom('clientBalances').select('balance').where('clientId', '=', clientId).executeTakeFirst();
  return row?.balance ?? 0;
}

export interface CancelBookingInput {
  bookingId: string;
  now?: Date;
}

export interface CancelledLesson {
  status: 'cancelled' | 'late_cancelled';
  /** Ile lekcji wróciło na konto klienta (0 przy odwołaniu po terminie). */
  refundedCredits: number;
}

/** Ostatnia chwila, w której odwołanie zwraca lekcję na konto. */
export function cancelDeadline(startsAt: Date, cancelDeadlineHours: number): Date {
  return new Date(startsAt.getTime() - cancelDeadlineHours * HOUR);
}

/**
 * Odwołuje lekcję. Do cancel_deadline_hours przed lekcją: 'cancelled' i zwrot lekcji (wpis booking_refund).
 * Później: 'late_cancelled' i lekcja przepada. Klient odwołuje tylko swoje lekcje, szkoła każdą.
 */
export function cancelBooking(db: Database, ctx: FirmContext, input: CancelBookingInput): Promise<CancelledLesson> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    const booking = await tx
      .selectFrom('bookings')
      .select(['id', 'clientId', 'startsAt', 'status'])
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking || (!actor.isStaff && booking.clientId !== actor.ownClientId)) throw new BookingError('booking_not_found');
    if (booking.status !== 'confirmed') throw new BookingError('not_cancellable');
    if (now.getTime() >= booking.startsAt.getTime()) throw new BookingError('already_started');

    const rules = await loadFirmRules(tx, ctx.organizationId);
    const onTime = now.getTime() <= cancelDeadline(booking.startsAt, rules.cancelDeadlineHours).getTime();
    const status = onTime ? 'cancelled' : 'late_cancelled';
    await tx
      .updateTable('bookings')
      .set({ status, cancelledAt: now, cancelledBy: ctx.userId })
      .where('id', '=', booking.id)
      .execute();

    let refundedCredits = 0;
    if (onTime) {
      const charge = await tx
        .selectFrom('creditEntries')
        .select('delta')
        .where('bookingId', '=', booking.id)
        .where('reason', '=', 'booking')
        .executeTakeFirst();
      if (charge) {
        refundedCredits = -charge.delta;
        await tx
          .insertInto('creditEntries')
          .values({
            organizationId: ctx.organizationId,
            clientId: booking.clientId,
            delta: refundedCredits,
            reason: 'booking_refund',
            bookingId: booking.id,
            createdBy: ctx.userId,
          })
          .execute();
      }
    }
    return { status, refundedCredits };
  });
}
