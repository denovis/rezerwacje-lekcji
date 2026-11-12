// Otwieranie płatności online i sprawdzenie jej po powrocie pary ze strony Stripe.
// Kod serwera (akcje i strony); zasady płatności są w src/lib/payments.ts.
import type { FirmContext } from './bookings';
import type { Database } from './db';
import {
  abandonPayment,
  attachCheckout,
  checkoutRequestFor,
  handleCheckoutEvent,
  PaymentError,
  sessionBelongsTo,
  type CheckoutOutcome,
} from './payments';
import type { PaymentGateway } from './stripe-gateway';

/** Placeholder, który Stripe zamienia na identyfikator sesji w adresie powrotu. */
const SESSION_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

/**
 * Zakłada sesję płatności Stripe dla oczekującej płatności pary i zwraca adres strony płatności.
 * Gdy się nie uda, płatność przepada, a termin wraca do puli (para może spróbować jeszcze raz).
 */
export async function openCheckout(
  db: Database,
  gateway: PaymentGateway,
  baseUrl: string,
  ctx: FirmContext,
  slug: string,
  paymentId: string,
): Promise<string> {
  const { lessonWeek, ...request } = await checkoutRequestFor(db, ctx, { paymentId });
  // Powrót do tygodnia opłaconej lekcji (przy pakiecie: do bieżącego tygodnia).
  const back = `${baseUrl}/panel/${encodeURIComponent(slug)}?${lessonWeek ? `tydzien=${lessonWeek}&` : ''}`;
  try {
    const session = await gateway.createCheckout({
      ...request,
      successUrl: `${back}platnosc=ok&sesja=${SESSION_PLACEHOLDER}`,
      cancelUrl: `${back}platnosc=przerwana`,
    });
    if (!session.url) throw new Error('Stripe nie zwrócił adresu strony płatności.');
    await attachCheckout(db, ctx, { paymentId, sessionId: session.id });
    return session.url;
  } catch (err) {
    console.error('Nie udało się założyć sesji płatności Stripe:', err);
    await abandonPayment(db, ctx, { paymentId });
    throw new PaymentError('checkout_failed');
  }
}

/**
 * Po powrocie pary ze strony płatności sprawdzamy sesję w Stripe: zapłacona dopisuje lekcje od razu,
 * nawet gdy webhook jeszcze nie dotarł (albo lokalnie nie działa Stripe CLI). Powtórzenia nic nie dublują.
 * Null, gdy sesja nie należy do tej firmy albo nie jest jeszcze zakończona.
 */
export async function syncReturnedCheckout(
  db: Database,
  gateway: PaymentGateway,
  organizationId: string,
  sessionId: string,
): Promise<CheckoutOutcome | null> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  const session = await gateway.retrieveCheckout(sessionId);
  if (!sessionBelongsTo(session, organizationId) || session.status !== 'complete') return null;
  return handleCheckoutEvent(db, { kind: 'completed', session });
}
