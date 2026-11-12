// Webhook Stripe: potwierdzenia płatności (Checkout) dopisują lekcje, a wygasłe zwalniają terminy.
// Lokalnie zdarzenia przekazuje Stripe CLI: stripe listen --forward-to localhost:3000/api/stripe/webhook
// Podpis zdarzenia sprawdza parseCheckoutEvent (STRIPE_WEBHOOK_SECRET); obsługa jest odporna na powtórzenia.
import { handleCheckoutEvent } from '../../../../lib/payments';
import { server } from '../../../../lib/server';
import { parseCheckoutEvent } from '../../../../lib/stripe-gateway';

export async function POST(request: Request): Promise<Response> {
  const { db, stripeWebhookSecret } = server();
  if (!stripeWebhookSecret) return new Response('Brak STRIPE_WEBHOOK_SECRET.', { status: 503 });
  const signature = request.headers.get('stripe-signature');
  if (!signature) return new Response('Brak podpisu Stripe.', { status: 400 });

  const body = await request.text();
  let event;
  try {
    event = parseCheckoutEvent(body, signature, stripeWebhookSecret);
  } catch {
    return new Response('Zły podpis Stripe.', { status: 400 });
  }
  // Inne zdarzenia (np. o samych płatnościach) potwierdzamy, ale ich nie obsługujemy.
  if (!event) return new Response('Pominięte.', { status: 200 });

  const outcome = await handleCheckoutEvent(db, event);
  return new Response(outcome, { status: 200 });
}
