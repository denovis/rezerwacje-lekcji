// Klienci w panelu szkoły: dodawanie pary, dane i status z limitem, historia lekcji z ręczną korektą salda,
// lista osób na minusie i oznaczanie nieobecności. Robi to tylko szkoła (właściciel, admin).
//
// Zasady (docs/decyzje.md, „Klienci w panelu”):
//  * Para dodana z adresem e-mail dostaje konto logowania (to samo, jeśli adres już jest w systemie).
//  * Limit zejścia poniżej zera ma tylko zaufana para; przy zmianie na zaufaną dostaje domyślny limit firmy.
//  * Saldo to suma historii. Korekta to nowy wpis 'adjustment' z autorem i notatką; historii nie zmieniamy.
//  * Nieobecność (no_show) można oznaczyć od początku lekcji; lekcja przepada (nic nie wraca na konto).
//  * Każda zmiana danych, statusu i nieobecności trafia do dziennika (audit_log).
import { sql } from 'kysely';
import { actorOf, type FirmContext } from './bookings';
import { withTenant, type Database, type Tx } from './db';
import type { BookingStatus, ClientStatus, CreditReason, Json } from './db-types';
import { formatDate, formatDay, formatMoney, formatTime } from './format';
import { isLocalDate } from './local-time';

const MESSAGES = {
  not_allowed: 'Klientów prowadzi tylko właściciel albo administrator szkoły.',
  invalid_request: 'Nieprawidłowe dane formularza. Odśwież stronę i spróbuj ponownie.',
  name_required: 'Podaj nazwę pary, np. „Anna i Piotr”.',
  name_too_long: 'Nazwa może mieć najwyżej 80 znaków.',
  invalid_email: 'Podaj poprawny adres e-mail albo zostaw to pole puste.',
  email_taken: 'Ta szkoła ma już klienta z tym adresem e-mail.',
  invalid_phone: 'Numer telefonu może mieć najwyżej 40 znaków.',
  invalid_date: 'Podaj poprawną datę ślubu albo zostaw to pole puste.',
  notes_too_long: 'Notatka może mieć najwyżej 1000 znaków.',
  client_not_found: 'Nie znaleziono klienta.',
  invalid_limit: 'Limit zejścia poniżej zera: od 0 do 20 lekcji.',
  adjustment_zero: 'Podaj liczbę lekcji różną od zera.',
  adjustment_too_big: 'Jedna korekta może zmienić saldo najwyżej o 50 lekcji.',
  note_required: 'Napisz w notatce, skąd ta korekta, np. „gotówka 900 zł za 5 lekcji”.',
  booking_not_found: 'Nie znaleziono lekcji.',
  no_show_too_early: 'Nieobecność można oznaczyć dopiero od początku lekcji.',
  no_show_not_possible: 'Tej lekcji nie można oznaczyć jako nieobecność (jest odwołana albo nieopłacona).',
  not_no_show: 'Ta lekcja nie jest oznaczona jako nieobecność.',
} as const;

export type ClientErrorCode = keyof typeof MESSAGES;

/** Odmowa przy zmianie klienta; komunikat po polsku można pokazać użytkownikowi. */
export class ClientError extends Error {
  constructor(readonly code: ClientErrorCode) {
    super(MESSAGES[code]);
    this.name = 'ClientError';
  }
}

/** Najwyższy limit zejścia poniżej zera dla jednej pary (także domyślny limit w ustawieniach). */
export const MAX_CREDIT_LIMIT = 20;
/** Najwięcej lekcji w jednej ręcznej korekcie. */
const MAX_ADJUSTMENT = 50;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireStaff(tx: Tx, ctx: FirmContext): Promise<void> {
  const actor = await actorOf(tx, ctx);
  if (!actor.isStaff) throw new ClientError('not_allowed');
}

async function audit(tx: Tx, ctx: FirmContext, action: string, entity: string, entityId: string, data: Json = {}) {
  await tx
    .insertInto('auditLog')
    .values({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action, entity, entityId, data: JSON.stringify(data) })
    .execute();
}

// --- Lista klientów ---------------------------------------------------------------------------------

export interface ClientSummary {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  /** Data ślubu (RRRR-MM-DD). */
  targetDate: string | null;
  notes: string | null;
  status: ClientStatus;
  creditLimit: number;
  /** Saldo lekcji: suma historii (credit_entries). */
  balance: number;
  /** Para loguje się do aplikacji (ma konto). */
  hasAccount: boolean;
  /** Najbliższa zaplanowana lekcja, np. „czwartek, 12 listopada, 17:00”. */
  nextLesson: string | null;
}

export interface ClientsOverview {
  timeZone: string;
  /** Waluta firmy, np. PLN. */
  currency: string;
  /** Domyślny limit zaufanej pary z ustawień firmy (default_trusted_credit_limit). */
  defaultTrustedCreditLimit: number;
  /** Aktywne pakiety do sprzedaży (wpłata gotówką), w kolejności dodania. */
  packages: { id: string; name: string; credits: number; priceCents: number }[];
  /** Cena pojedynczej lekcji domyślnej usługi (w groszach), jeśli szkoła ją ustawiła. */
  lessonPriceCents: number | null;
  /** Według nazwy. */
  clients: ClientSummary[];
}

/** Pary na minusie (saldo poniżej zera), od największego długu. */
export function clientsInDebt<T extends { balance: number; displayName: string }>(clients: T[]): T[] {
  return clients
    .filter((c) => c.balance < 0)
    .sort((a, b) => a.balance - b.balance || a.displayName.localeCompare(b.displayName, 'pl'));
}

/** Wszyscy klienci firmy z saldem i najbliższą lekcją (tylko dla szkoły). */
export function loadClients(db: Database, ctx: FirmContext, now: Date = new Date()): Promise<ClientsOverview> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const settings = await tx
      .selectFrom('organizations as o')
      .innerJoin('organizationSettings as s', 's.organizationId', 'o.id')
      .select(['o.timezone', 'o.currency', 's.defaultTrustedCreditLimit'])
      .where('o.id', '=', ctx.organizationId)
      .executeTakeFirstOrThrow();
    const packages = await tx
      .selectFrom('packages')
      .select(['id', 'name', 'credits', 'priceCents'])
      .where('organizationId', '=', ctx.organizationId)
      .where('active', '=', true)
      .orderBy('createdAt')
      .execute();
    // Domyślna usługa w kalendarzu to pierwsza dodana (jak w firmOverview).
    const service = await tx
      .selectFrom('services')
      .select('priceCents')
      .where('organizationId', '=', ctx.organizationId)
      .where('active', '=', true)
      .orderBy('createdAt')
      .orderBy('name')
      .executeTakeFirst();
    const rows = await tx
      .selectFrom('clients as c')
      .leftJoin('clientBalances as b', 'b.clientId', 'c.id')
      .select((eb) => [
        'c.id',
        'c.displayName',
        'c.email',
        'c.phone',
        eb.fn<string | null>('to_char', [eb.ref('c.targetDate'), eb.val('YYYY-MM-DD')]).as('targetDate'),
        'c.notes',
        'c.status',
        'c.creditLimit',
        'c.userId',
        'b.balance',
      ])
      .where('c.organizationId', '=', ctx.organizationId) // RLS pokazuje też własne profile klienta w innych firmach
      .execute();
    const next = await tx
      .selectFrom('bookings')
      .select((eb) => ['clientId', eb.fn.min<Date>('startsAt').as('startsAt')])
      .where('status', 'in', ['pending_payment', 'confirmed'])
      .where('startsAt', '>=', now)
      .groupBy('clientId')
      .execute();
    const tz = settings.timezone;
    return {
      timeZone: tz,
      currency: settings.currency,
      defaultTrustedCreditLimit: settings.defaultTrustedCreditLimit,
      packages,
      lessonPriceCents: service?.priceCents ?? null,
      clients: rows
        .map((r): ClientSummary => {
          const lesson = next.find((n) => n.clientId === r.id)?.startsAt;
          return {
            id: r.id,
            displayName: r.displayName,
            email: r.email,
            phone: r.phone,
            targetDate: r.targetDate,
            notes: r.notes,
            status: r.status,
            creditLimit: r.creditLimit,
            balance: r.balance ?? 0,
            hasAccount: r.userId !== null,
            nextLesson: lesson ? `${formatDay(lesson, tz)}, ${formatTime(lesson, tz)}` : null,
          };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pl')),
    };
  });
}

// --- Dodawanie i zmiana danych ------------------------------------------------------------------------

export interface ClientInput {
  displayName: string;
  /** Adres, którym para loguje się do aplikacji; pusty = bez konta. */
  email?: string | null;
  phone?: string | null;
  /** Data ślubu (RRRR-MM-DD); pusta = brak. */
  targetDate?: string | null;
  notes?: string | null;
  /** Domyślnie nowa para. */
  status?: ClientStatus;
  /** Tylko dla zaufanej pary; brak = domyślny limit firmy. */
  creditLimit?: number | null;
}

interface CleanClient {
  displayName: string;
  email: string | null;
  phone: string | null;
  targetDate: string | null;
  notes: string | null;
  status: ClientStatus;
}

function clean(input: ClientInput): CleanClient {
  const displayName = (input.displayName ?? '').trim();
  if (!displayName) throw new ClientError('name_required');
  if (displayName.length > 80) throw new ClientError('name_too_long');
  const email = (input.email ?? '').trim() || null;
  if (email && (email.length > 254 || !EMAIL.test(email))) throw new ClientError('invalid_email');
  const phone = (input.phone ?? '').trim() || null;
  if (phone && phone.length > 40) throw new ClientError('invalid_phone');
  const targetDate = (input.targetDate ?? '').trim() || null;
  if (targetDate && !isLocalDate(targetDate)) throw new ClientError('invalid_date');
  const notes = (input.notes ?? '').trim() || null;
  if (notes && notes.length > 1000) throw new ClientError('notes_too_long');
  const status = input.status ?? 'new';
  if (!['new', 'regular', 'trusted'].includes(status)) throw new ClientError('invalid_request');
  return { displayName, email, phone, targetDate, notes, status };
}

/**
 * Limit zejścia poniżej zera dla statusu: zaufana para dostaje podany limit albo domyślny limit firmy,
 * pozostali zawsze 0 (tak samo pilnuje baza).
 */
async function limitFor(tx: Tx, ctx: FirmContext, status: ClientStatus, requested: number | null | undefined): Promise<number> {
  if (status !== 'trusted') return 0;
  if (requested === null || requested === undefined) {
    const row = await tx
      .selectFrom('organizationSettings')
      .select('defaultTrustedCreditLimit')
      .where('organizationId', '=', ctx.organizationId)
      .executeTakeFirstOrThrow();
    return Math.min(row.defaultTrustedCreditLimit, MAX_CREDIT_LIMIT);
  }
  if (!Number.isInteger(requested) || requested < 0 || requested > MAX_CREDIT_LIMIT) throw new ClientError('invalid_limit');
  return requested;
}

/** Konto logowania dla adresu pary (to samo konto, jeśli adres już jest w systemie). */
async function accountFor(tx: Tx, email: string): Promise<string> {
  await tx
    .insertInto('users')
    .values({ email })
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();
  const user = await tx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow();
  return user.id;
}

/** Czy adres albo konto ma już inny klient tej firmy. */
async function emailTaken(tx: Tx, ctx: FirmContext, email: string, userId: string, exceptId: string | null): Promise<boolean> {
  let query = tx
    .selectFrom('clients')
    .select('id')
    .where('organizationId', '=', ctx.organizationId)
    .where((eb) => eb.or([eb('email', '=', email), eb('userId', '=', userId)]));
  if (exceptId) query = query.where('id', '!=', exceptId);
  return (await query.executeTakeFirst()) !== undefined;
}

/** Dodaje parę. Z adresem e-mail para od razu może się zalogować i rezerwować. */
export function addClient(db: Database, ctx: FirmContext, input: ClientInput): Promise<{ id: string }> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const client = clean(input);
    const creditLimit = await limitFor(tx, ctx, client.status, input.creditLimit);
    let userId: string | null = null;
    if (client.email) {
      userId = await accountFor(tx, client.email);
      if (await emailTaken(tx, ctx, client.email, userId, null)) throw new ClientError('email_taken');
    }
    const row = await tx
      .insertInto('clients')
      .values({ organizationId: ctx.organizationId, ...client, creditLimit, userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(tx, ctx, 'client.added', 'clients', row.id, { ...client, creditLimit });
    return row;
  });
}

export interface ClientUpdate extends ClientInput {
  clientId: string;
  status: ClientStatus;
}

/**
 * Zmienia dane, status i limit pary. Zmiana adresu e-mail łączy profil z kontem tego adresu.
 * Usunięcie adresu nie odłącza konta, którym para już się loguje.
 */
export function updateClient(db: Database, ctx: FirmContext, input: ClientUpdate): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const client = clean(input);
    const current = await tx
      .selectFrom('clients')
      .select(['id', 'email', 'userId', 'status', 'creditLimit'])
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.clientId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new ClientError('client_not_found');
    // Przy zmianie na zaufaną bez podanego limitu: domyślny limit firmy; zaufana bez zmiany statusu zachowuje swój.
    const requested =
      input.creditLimit ?? (client.status === 'trusted' && current.status === 'trusted' ? current.creditLimit : undefined);
    const creditLimit = await limitFor(tx, ctx, client.status, requested);

    let userId = current.userId;
    const emailChanged = (client.email ?? '').toLowerCase() !== (current.email ?? '').toLowerCase();
    if (client.email && emailChanged) {
      userId = await accountFor(tx, client.email);
      if (await emailTaken(tx, ctx, client.email, userId, current.id)) throw new ClientError('email_taken');
    }
    await tx
      .updateTable('clients')
      .set({ ...client, creditLimit, userId })
      .where('id', '=', current.id)
      .execute();
    await audit(tx, ctx, 'client.updated', 'clients', current.id, {
      ...client,
      creditLimit,
      previousStatus: current.status,
      previousCreditLimit: current.creditLimit,
    });
  });
}

// --- Historia lekcji i korekta salda -------------------------------------------------------------------

export const CREDIT_REASON_LABELS: Record<CreditReason, string> = {
  purchase: 'Płatność',
  booking: 'Rezerwacja lekcji',
  booking_refund: 'Zwrot za odwołaną lekcję',
  adjustment: 'Korekta',
};

export interface HistoryEntry {
  id: string;
  reason: CreditReason;
  reasonLabel: string;
  /** Np. „11 listopada, 18:20”. */
  when: string;
  delta: number;
  /** Saldo po tym wpisie. */
  balanceAfter: number;
  /** Lekcja (termin i status), notatka korekty albo opis płatności. */
  details: string | null;
  /** Kto dopisał (e-mail), jeśli wiadomo. */
  author: string | null;
  /** Status lekcji, której dotyczy wpis (np. no_show). */
  bookingStatus: BookingStatus | null;
}

export interface ClientHistory {
  balance: number;
  /** Od najnowszego. */
  entries: HistoryEntry[];
}

const LESSON_STATUS: Partial<Record<BookingStatus, string>> = {
  pending_payment: 'czeka na płatność',
  completed: 'odbyta',
  no_show: 'nieobecność',
  cancelled: 'odwołana',
  late_cancelled: 'odwołana po terminie',
  expired: 'nieopłacona w terminie',
};

/** Historia lekcji pary: wszystkie wpisy salda od najnowszego, z saldem po każdym wpisie (tylko dla szkoły). */
export function clientHistory(db: Database, ctx: FirmContext, input: { clientId: string }): Promise<ClientHistory> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const { timeZone, currency } = await tx
      .selectFrom('organizations')
      .select(['timezone as timeZone', 'currency'])
      .where('id', '=', ctx.organizationId)
      .executeTakeFirstOrThrow();
    const client = await tx
      .selectFrom('clients')
      .select('id')
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.clientId)
      .executeTakeFirst();
    if (!client) throw new ClientError('client_not_found');

    const rows = await tx
      .selectFrom('creditEntries as e')
      .leftJoin('bookings as b', 'b.id', 'e.bookingId')
      .leftJoin('payments as p', 'p.id', 'e.paymentId')
      .leftJoin('packages as k', 'k.id', 'p.packageId')
      .leftJoin('users as u', 'u.id', 'e.createdBy')
      .select([
        'e.id',
        'e.reason',
        'e.delta',
        'e.note',
        'e.createdAt',
        'b.startsAt',
        'b.endsAt',
        'b.status as bookingStatus',
        'p.method',
        'p.amountCents',
        'k.name as packageName',
        'u.email as author',
      ])
      .where('e.clientId', '=', client.id)
      // Ta sama chwila (np. dwa wpisy w jednej transakcji): kolejność stała dzięki id.
      .orderBy('e.createdAt')
      .orderBy('e.id')
      .execute();

    let balance = 0;
    const entries = rows.map((r): HistoryEntry => {
      balance += r.delta;
      let details: string | null = r.note;
      if (r.startsAt && r.endsAt) {
        const status = r.bookingStatus ? LESSON_STATUS[r.bookingStatus] : undefined;
        details = `lekcja ${formatDay(r.startsAt, timeZone)}, ${formatTime(r.startsAt, timeZone)}–${formatTime(r.endsAt, timeZone)}${status ? ` (${status})` : ''}`;
      } else if (r.method) {
        const amount = r.amountCents !== null ? formatMoney(r.amountCents, currency) : '';
        details = [r.method === 'cash' ? 'gotówka' : 'online', r.packageName, amount, r.note].filter(Boolean).join(', ');
      }
      return {
        id: r.id,
        reason: r.reason,
        reasonLabel: CREDIT_REASON_LABELS[r.reason],
        when: `${formatDate(r.createdAt, timeZone)}, ${formatTime(r.createdAt, timeZone)}`,
        delta: r.delta,
        balanceAfter: balance,
        details,
        author: r.author,
        bookingStatus: r.bookingStatus,
      };
    });
    return { balance, entries: entries.reverse() };
  });
}

/**
 * Ręczna korekta salda: nowy wpis 'adjustment' z autorem i notatką (np. gotówka przed etapem płatności,
 * zwrot lekcji odwołanej przez szkołę po terminie). Zwraca saldo po korekcie.
 */
export function adjustBalance(
  db: Database,
  ctx: FirmContext,
  input: { clientId: string; delta: number; note: string },
): Promise<{ balance: number }> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    if (!Number.isInteger(input.delta) || input.delta === 0) throw new ClientError('adjustment_zero');
    if (Math.abs(input.delta) > MAX_ADJUSTMENT) throw new ClientError('adjustment_too_big');
    const note = (input.note ?? '').trim();
    if (!note) throw new ClientError('note_required');
    if (note.length > 500) throw new ClientError('notes_too_long');
    // Blokada wiersza klienta: korekta i rezerwacja tej pary w tej samej chwili czekają na siebie.
    const client = await tx
      .selectFrom('clients')
      .select('id')
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.clientId)
      .forUpdate()
      .executeTakeFirst();
    if (!client) throw new ClientError('client_not_found');
    await tx
      .insertInto('creditEntries')
      .values({
        organizationId: ctx.organizationId,
        clientId: client.id,
        delta: input.delta,
        reason: 'adjustment',
        createdBy: ctx.userId,
        note,
      })
      .execute();
    const row = await tx
      .selectFrom('clientBalances')
      .select('balance')
      .where('clientId', '=', client.id)
      .executeTakeFirst();
    return { balance: row?.balance ?? 0 };
  });
}

// --- Nieobecność -----------------------------------------------------------------------------------------

/** Statusy lekcji, które można oznaczyć jako nieobecność. */
const NO_SHOW_FROM: BookingStatus[] = ['confirmed', 'completed'];

/** Czy lekcję można już oznaczyć jako nieobecność (od jej początku, tylko zarezerwowaną albo odbytą). */
export function canMarkNoShow(status: BookingStatus, startsAt: Date, now: Date): boolean {
  return NO_SHOW_FROM.includes(status) && now.getTime() >= startsAt.getTime();
}

/** Oznacza nieobecność pary: status no_show, lekcja przepada (nic nie wraca na konto). */
export function markNoShow(db: Database, ctx: FirmContext, input: { bookingId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const booking = await tx
      .selectFrom('bookings')
      .select(['id', 'status', 'startsAt'])
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking) throw new ClientError('booking_not_found');
    if (!NO_SHOW_FROM.includes(booking.status)) throw new ClientError('no_show_not_possible');
    if (!canMarkNoShow(booking.status, booking.startsAt, now)) throw new ClientError('no_show_too_early');
    await tx.updateTable('bookings').set({ status: 'no_show' }).where('id', '=', booking.id).execute();
    await audit(tx, ctx, 'booking.no_show', 'bookings', booking.id, { previousStatus: booking.status });
  });
}

/** Cofa pomyłkowo oznaczoną nieobecność: lekcja wraca do statusu sprzed oznaczenia (z dziennika) albo „zarezerwowana”. */
export function undoNoShow(db: Database, ctx: FirmContext, input: { bookingId: string }): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const booking = await tx
      .selectFrom('bookings')
      .select(['id', 'status'])
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking) throw new ClientError('booking_not_found');
    if (booking.status !== 'no_show') throw new ClientError('not_no_show');
    const marked = await tx
      .selectFrom('auditLog')
      .select(sql<string | null>`data->>'previousStatus'`.as('previousStatus'))
      .where('entity', '=', 'bookings')
      .where('entityId', '=', booking.id)
      .where('action', '=', 'booking.no_show')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    const previous = marked?.previousStatus === 'completed' ? 'completed' : 'confirmed';
    await tx.updateTable('bookings').set({ status: previous }).where('id', '=', booking.id).execute();
    await audit(tx, ctx, 'booking.no_show_undone', 'bookings', booking.id, { status: previous });
  });
}
