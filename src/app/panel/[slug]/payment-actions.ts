'use server';
// Akcje płatności online pary: kupno pakietu, dokończenie płatności za lekcję i rezygnacja z niej.
// Zwracają adres strony płatności Stripe albo komunikat po polsku; zasady pilnuje src/lib/payments.ts.
import { revalidatePath } from 'next/cache';
import type { FirmContext } from '../../../lib/bookings';
import { openCheckout } from '../../../lib/checkout';
import { findMyFirm } from '../../../lib/firms';
import { cancelPendingBooking, PaymentError, pendingCheckout, startPackagePurchase } from '../../../lib/payments';
import { server } from '../../../lib/server';
import { requireUser } from '../../../lib/session';

export type PaymentResult = { ok: true; checkoutUrl?: string } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = 'Szkoła nie ma jeszcze płatności online. Skontaktuj się ze szkołą.';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

async function attempt(
  slugInput: unknown,
  id: unknown,
  change: (ctx: FirmContext, id: string) => Promise<PaymentResult>,
): Promise<PaymentResult> {
  const slug = text(slugInput);
  const user = await requireUser();
  const firm = await findMyFirm(server().db, user.id, slug);
  if (!firm) return { ok: false, error: 'Nie masz do tego dostępu.' };
  if (!UUID.test(text(id))) return { ok: false, error: 'Nieprawidłowe dane formularza. Odśwież stronę i spróbuj ponownie.' };
  try {
    return await change({ organizationId: firm.id, userId: user.id }, text(id));
  } catch (err) {
    if (err instanceof PaymentError) return { ok: false, error: err.message };
    throw err;
  } finally {
    revalidatePath(`/panel/${slug}`);
  }
}

/** Para kupuje pakiet lekcji online: przechodzi na stronę płatności, a lekcje trafią na konto po zapłacie. */
export async function buyPackageAction(input: { slug: string; packageId: string }): Promise<PaymentResult> {
  return attempt(input?.slug, input?.packageId, async (ctx, packageId) => {
    const { db, payments, baseUrl } = server();
    if (!payments) return { ok: false, error: UNAVAILABLE };
    const { paymentId } = await startPackagePurchase(db, ctx, { packageId });
    return { ok: true, checkoutUrl: await openCheckout(db, payments, baseUrl, ctx, input.slug, paymentId) };
  });
}

/** Dokończenie płatności za lekcję, która czeka na płatność (np. po przerwaniu płatności). */
export async function resumePaymentAction(input: { slug: string; bookingId: string }): Promise<PaymentResult> {
  return attempt(input?.slug, input?.bookingId, async (ctx, bookingId) => {
    const { db, payments, baseUrl } = server();
    if (!payments) return { ok: false, error: UNAVAILABLE };
    const pending = await pendingCheckout(db, ctx, { bookingId });
    if (pending.sessionId) {
      const session = await payments.retrieveCheckout(pending.sessionId);
      if (session.status === 'open' && session.url) return { ok: true, checkoutUrl: session.url };
      // Sesja już się skończyła: termin zwalniamy, para rezerwuje jeszcze raz.
      await cancelPendingBooking(db, ctx, { bookingId });
      return { ok: false, error: new PaymentError('checkout_closed').message };
    }
    return { ok: true, checkoutUrl: await openCheckout(db, payments, baseUrl, ctx, input.slug, pending.paymentId) };
  });
}

/** Para rezygnuje z lekcji czekającej na płatność: termin wraca do puli, a strona płatności się zamyka. */
export async function cancelPendingAction(input: { slug: string; bookingId: string }): Promise<PaymentResult> {
  return attempt(input?.slug, input?.bookingId, async (ctx, bookingId) => {
    const { db, payments } = server();
    const { sessionId } = await cancelPendingBooking(db, ctx, { bookingId });
    if (sessionId && payments) {
      // Zamknięcie sesji w Stripe; gdyby się nie udało, sesja i tak wygaśnie, a późna wpłata trafi na konto.
      await payments.expireCheckout(sessionId).catch((err: unknown) => console.error('Nie udało się zamknąć sesji Stripe:', err));
    }
    return { ok: true };
  });
}
