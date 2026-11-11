'use server';
// Akcje kalendarza: rezerwacja i odwołanie lekcji. Wywołuje je kalendarz w przeglądarce,
// a wynik (powodzenie albo komunikat po polsku) pokazuje bez przechodzenia na inną stronę.
// Każda akcja sama sprawdza logowanie i dostęp do firmy; zasady rezerwacji pilnuje src/lib/bookings.ts.
import { revalidatePath } from 'next/cache';
import { bookingErrorMessage, bookLesson, BookingError, cancelBooking, type FirmContext } from '../../../lib/bookings';
import { firmTimeZone } from '../../../lib/calendar';
import { findMyFirm } from '../../../lib/firms';
import { isLocalDate, localToInstant, timeToMinutes } from '../../../lib/local-time';
import { server } from '../../../lib/server';
import { requireUser } from '../../../lib/session';

export type ActionResult = { ok: true; refunded?: boolean } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const failure = (code: Parameters<typeof bookingErrorMessage>[0]): ActionResult => ({ ok: false, error: bookingErrorMessage(code) });

async function firmContext(slug: string): Promise<FirmContext | null> {
  const user = await requireUser();
  const firm = await findMyFirm(server().db, user.id, slug);
  return firm ? { organizationId: firm.id, userId: user.id } : null;
}

export interface BookInput {
  slug: string;
  serviceId: string;
  clientId: string;
  instructorId: string;
  /** Wolny termin z kalendarza (ISO)… */
  startsAt?: string;
  /** …albo, dla szkoły, dowolny dzień i godzina w czasie lokalnym firmy. */
  date?: string;
  time?: string;
}

/** Rezerwacja wolnego terminu albo (szkoła) lekcji o dowolnej godzinie. */
export async function bookAction(input: BookInput): Promise<ActionResult> {
  const slug = text(input?.slug);
  const ctx = await firmContext(slug);
  if (!ctx) return failure('not_allowed');
  const [serviceId, clientId, instructorId] = [text(input.serviceId), text(input.clientId), text(input.instructorId)];
  if (![serviceId, clientId, instructorId].every((id) => UUID.test(id))) return failure('invalid_request');

  let startsAt: Date;
  if (input.startsAt !== undefined) {
    startsAt = new Date(text(input.startsAt));
  } else {
    const [date, time] = [text(input.date), text(input.time)];
    if (!isLocalDate(date) || !TIME.test(time)) return failure('invalid_time');
    startsAt = new Date(localToInstant(date, timeToMinutes(time), await firmTimeZone(server().db, ctx)));
  }
  if (Number.isNaN(startsAt.getTime())) return failure('invalid_time');

  try {
    await bookLesson(server().db, ctx, { clientId, instructorId, serviceId, startsAt });
    return { ok: true };
  } catch (err) {
    if (err instanceof BookingError) return failure(err.code);
    throw err;
  } finally {
    // Kalendarz pobiera świeże dane także po odmowie (np. ktoś właśnie zajął termin).
    revalidatePath(`/panel/${slug}`);
  }
}

/** Odwołanie lekcji: w terminie lekcja wraca na konto, po terminie przepada. */
export async function cancelAction(input: { slug: string; bookingId: string }): Promise<ActionResult> {
  const slug = text(input?.slug);
  const ctx = await firmContext(slug);
  if (!ctx) return failure('not_allowed');
  const bookingId = text(input.bookingId);
  if (!UUID.test(bookingId)) return failure('booking_not_found');

  try {
    const result = await cancelBooking(server().db, ctx, { bookingId });
    return { ok: true, refunded: result.status === 'cancelled' };
  } catch (err) {
    if (err instanceof BookingError) return failure(err.code);
    throw err;
  } finally {
    revalidatePath(`/panel/${slug}`);
  }
}
