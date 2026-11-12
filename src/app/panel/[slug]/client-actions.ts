'use server';
// Akcje klientów: dodanie i zmiana pary, historia lekcji, korekta salda, wpłata gotówką, nieobecność.
// Wywołują je strona Klienci i kalendarz; wynik (powodzenie albo komunikat po polsku) pokazują na miejscu.
// Każda akcja sama sprawdza logowanie i dostęp do firmy; zasady pilnuje src/lib/clients.ts.
import { revalidatePath } from 'next/cache';
import type { FirmContext } from '../../../lib/bookings';
import {
  addClient,
  adjustBalance,
  ClientError,
  clientHistory,
  markNoShow,
  undoNoShow,
  updateClient,
  type ClientHistory,
} from '../../../lib/clients';
import type { ClientStatus } from '../../../lib/db-types';
import { findMyFirm } from '../../../lib/firms';
import { PaymentError, recordCashPayment } from '../../../lib/payments';
import { server } from '../../../lib/server';
import { requireUser } from '../../../lib/session';

export type ClientResult = { ok: true; balance?: number } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: ClientStatus[] = ['new', 'regular', 'trusted'];

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const uuid = (value: unknown) => {
  const id = text(value);
  if (!UUID.test(id)) throw new ClientError('invalid_request');
  return id;
};

async function firmContext(slug: string): Promise<FirmContext | null> {
  const user = await requireUser();
  const firm = await findMyFirm(server().db, user.id, slug);
  return firm ? { organizationId: firm.id, userId: user.id } : null;
}

/** Sprawdza logowanie i firmę, wykonuje zmianę i odświeża kalendarz oraz stronę klientów. */
async function attempt<R extends { ok: true }>(
  slugInput: unknown,
  change: (ctx: FirmContext) => Promise<R | void>,
): Promise<R | { ok: true } | { ok: false; error: string }> {
  const slug = text(slugInput);
  const ctx = await firmContext(slug);
  if (!ctx) return { ok: false, error: new ClientError('not_allowed').message };
  try {
    return (await change(ctx)) ?? { ok: true };
  } catch (err) {
    if (err instanceof ClientError) return { ok: false, error: err.message };
    throw err;
  } finally {
    revalidatePath(`/panel/${slug}`);
    revalidatePath(`/panel/${slug}/klienci`);
  }
}

export interface ClientPayload {
  slug: string;
  /** Brak: nowa para. */
  clientId?: string;
  displayName: string;
  email: string;
  phone: string;
  targetDate: string;
  notes: string;
  status: ClientStatus;
  /** Tylko dla zaufanej pary. */
  creditLimit: number | null;
}

export async function saveClientAction(input: ClientPayload): Promise<ClientResult> {
  return attempt(input?.slug, async (ctx) => {
    if (!STATUSES.includes(input.status)) throw new ClientError('invalid_request');
    const fields = {
      displayName: text(input.displayName),
      email: text(input.email),
      phone: text(input.phone),
      targetDate: text(input.targetDate),
      notes: text(input.notes),
      status: input.status,
      creditLimit: typeof input.creditLimit === 'number' ? input.creditLimit : null,
    };
    if (input.clientId === undefined) await addClient(server().db, ctx, fields);
    else await updateClient(server().db, ctx, { ...fields, clientId: uuid(input.clientId) });
  });
}

export async function adjustBalanceAction(input: { slug: string; clientId: string; delta: number; note: string }): Promise<ClientResult> {
  return attempt(input?.slug, async (ctx) => {
    const delta = typeof input.delta === 'number' ? input.delta : Number.NaN;
    const { balance } = await adjustBalance(server().db, ctx, { clientId: uuid(input.clientId), delta, note: text(input.note) });
    return { ok: true as const, balance };
  });
}

export async function markNoShowAction(input: { slug: string; bookingId: string }): Promise<ClientResult> {
  return attempt(input?.slug, (ctx) => markNoShow(server().db, ctx, { bookingId: uuid(input.bookingId) }));
}

export async function undoNoShowAction(input: { slug: string; bookingId: string }): Promise<ClientResult> {
  return attempt(input?.slug, (ctx) => undoNoShow(server().db, ctx, { bookingId: uuid(input.bookingId) }));
}

/** Historia lekcji pary do okienka (odczyt, bez odświeżania stron). */
export async function clientHistoryAction(input: {
  slug: string;
  clientId: string;
}): Promise<{ ok: true; history: ClientHistory } | { ok: false; error: string }> {
  const ctx = await firmContext(text(input?.slug));
  if (!ctx) return { ok: false, error: new ClientError('not_allowed').message };
  try {
    return { ok: true, history: await clientHistory(server().db, ctx, { clientId: uuid(input.clientId) }) };
  } catch (err) {
    if (err instanceof ClientError) return { ok: false, error: err.message };
    throw err;
  }
}

export interface CashPayload {
  slug: string;
  clientId: string;
  /** Sprzedany pakiet; null: pojedyncze lekcje. */
  packageId: string | null;
  /** Liczba lekcji, gdy wpłata nie jest za pakiet. */
  credits: number | null;
  /** Kwota w groszach. */
  amountCents: number;
  note: string;
}

/** Wpłata gotówką: dopisuje lekcje na konto pary i zapisuje, kto przyjął i ile zł. */
export async function cashPaymentAction(input: CashPayload): Promise<ClientResult> {
  const slug = text(input?.slug);
  const ctx = await firmContext(slug);
  if (!ctx) return { ok: false, error: new ClientError('not_allowed').message };
  try {
    const result = await recordCashPayment(server().db, ctx, {
      clientId: uuid(input.clientId),
      packageId: input.packageId ? uuid(input.packageId) : null,
      credits: typeof input.credits === 'number' ? input.credits : null,
      amountCents: typeof input.amountCents === 'number' ? input.amountCents : Number.NaN,
      note: text(input.note),
    });
    return { ok: true, balance: result.balance };
  } catch (err) {
    if (err instanceof ClientError || err instanceof PaymentError) return { ok: false, error: err.message };
    throw err;
  } finally {
    revalidatePath(`/panel/${slug}`);
    revalidatePath(`/panel/${slug}/klienci`);
  }
}
