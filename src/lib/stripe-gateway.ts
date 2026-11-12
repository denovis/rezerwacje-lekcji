// Połączenie ze Stripe: sesje płatności (Stripe Checkout) i zdarzenia z webhooka.
//
// Reszta aplikacji zna tylko interfejs PaymentGateway i zdarzenie CheckoutEvent. Dzięki temu zasady płatności
// (src/lib/payments.ts) testujemy na prawdziwej bazie bez łączenia się ze Stripe.
// Metody płatności: karta, BLIK i Przelewy24 (muszą być włączone w panelu Stripe; BLIK i P24 tylko w PLN).
import Stripe from 'stripe';

/** Prośba o sesję płatności dla jednej płatności z tabeli payments. */
export interface CheckoutRequest {
  organizationId: string;
  paymentId: string;
  amountCents: number;
  currency: string;
  /** Co para kupuje, np. „Lekcja pierwszego tańca, pt., 13 listopada, 17:45”. */
  description: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  /** Do kiedy można zapłacić (Stripe: od 30 minut do 24 godzin od teraz). */
  expiresAt: Date;
}

export interface CheckoutSession {
  id: string;
  /** Strona płatności Stripe; null, gdy sesja się skończyła. */
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  organizationId: string | null;
  paymentId: string | null;
  paymentIntentId: string | null;
}

export interface PaymentGateway {
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  retrieveCheckout(sessionId: string): Promise<CheckoutSession>;
  /** Kończy otwartą sesję (para zrezygnowała); zamknięta sesja zostaje bez zmian. */
  expireCheckout(sessionId: string): Promise<void>;
}

/** Zdarzenie z sesji płatności, już bez szczegółów Stripe. */
export interface CheckoutEvent {
  kind: 'completed' | 'async_succeeded' | 'async_failed' | 'expired';
  session: CheckoutSession;
}

/** Metody płatności w Checkout: karta, BLIK, Przelewy24. */
export const PAYMENT_METHODS = ['card', 'blik', 'p24'] as const;

function toSession(s: Stripe.Checkout.Session): CheckoutSession {
  const intent = s.payment_intent;
  return {
    id: s.id,
    url: s.url ?? null,
    status: (s.status ?? 'open') as CheckoutSession['status'],
    paymentStatus: s.payment_status as CheckoutSession['paymentStatus'],
    organizationId: s.metadata?.organizationId ?? null,
    paymentId: s.metadata?.paymentId ?? null,
    paymentIntentId: typeof intent === 'string' ? intent : (intent?.id ?? null),
  };
}

/** Parametry sesji Checkout dla płatności (osobno, żeby test sprawdził je bez łączenia się ze Stripe). */
export function checkoutParams(request: CheckoutRequest): Stripe.Checkout.SessionCreateParams {
  const metadata = { organizationId: request.organizationId, paymentId: request.paymentId };
  return {
    mode: 'payment',
    allowed_payment_method_types: [...PAYMENT_METHODS],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: request.currency.toLowerCase(),
          unit_amount: request.amountCents,
          product_data: { name: request.description },
        },
      },
    ],
    customer_email: request.customerEmail ?? undefined,
    client_reference_id: request.paymentId,
    metadata,
    payment_intent_data: { metadata },
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    expires_at: Math.floor(request.expiresAt.getTime() / 1000),
    locale: 'pl',
  };
}

/** Prawdziwe połączenie ze Stripe (klucz z STRIPE_SECRET_KEY). */
export function stripeGateway(secretKey: string): PaymentGateway {
  const stripe = new Stripe(secretKey);
  return {
    async createCheckout(request) {
      // Ten sam klucz przy ponowieniu: Stripe nie założy drugiej sesji dla tej samej płatności.
      const session = await stripe.checkout.sessions.create(checkoutParams(request), {
        idempotencyKey: `checkout-${request.paymentId}`,
      });
      return toSession(session);
    },
    async retrieveCheckout(sessionId) {
      return toSession(await stripe.checkout.sessions.retrieve(sessionId));
    },
    async expireCheckout(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status === 'open') await stripe.checkout.sessions.expire(sessionId);
    },
  };
}

const EVENT_KINDS: Record<string, CheckoutEvent['kind']> = {
  'checkout.session.completed': 'completed',
  'checkout.session.async_payment_succeeded': 'async_succeeded',
  'checkout.session.async_payment_failed': 'async_failed',
  'checkout.session.expired': 'expired',
};

/**
 * Zdarzenie z webhooka: sprawdza podpis (STRIPE_WEBHOOK_SECRET) i zwraca zdarzenie sesji płatności.
 * Null dla zdarzeń, których nie obsługujemy. Zły podpis rzuca błąd.
 */
export function parseCheckoutEvent(body: string, signature: string, webhookSecret: string): CheckoutEvent | null {
  const event = Stripe.webhooks.constructEvent(body, signature, webhookSecret);
  const kind = EVENT_KINDS[event.type];
  if (!kind) return null;
  return { kind, session: toSession(event.data.object as Stripe.Checkout.Session) };
}
