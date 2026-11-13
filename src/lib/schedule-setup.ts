// Ustawienia grafiku w panelu szkoły: instruktorzy, stałe godziny pracy, wyjątki (urlop, wolne,
// dodatkowe godziny), reguły grafiku i usługi. Zmienia je tylko szkoła (właściciel, admin).
//
// Zasady (docs/decyzje.md, „Ustawienia grafiku”):
//  * Nic nie kasujemy: instruktorów, usługi, godziny pracy i wyjątki wyłączamy flagą active.
//  * Stałe godziny pracy zmieniają się „od dnia” (dziś albo później). Godziny sprzed tego dnia
//    dostają valid_to = dzień wcześniej, a zaplanowane od tego dnia lub później wyłączamy.
//    Przeszłość zostaje bez zmian.
//  * Urlop i wolne nie odwołują lekcji: lekcje w tym czasie zostają, szkoła odwołuje je sama.
//  * Każda zmiana trafia do dziennika (audit_log).
import { sql } from 'kysely';
import { actorOf, BLOCKING_STATUSES, loadFirmRules, type FirmContext } from './bookings';
import { withTenant, type Database, type Tx } from './db';
import type { AvailabilityExceptionKind, Json } from './db-types';
import { formatShortDay } from './format';
import { addDays, isLocalDate, localDateOf, localTimeOf, localToInstant, timeToMinutes } from './local-time';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const MESSAGES = {
  not_allowed: 'Ustawienia zmienia tylko właściciel albo administrator szkoły.',
  invalid_request: 'Nieprawidłowe dane formularza. Odśwież stronę i spróbuj ponownie.',
  name_required: 'Podaj nazwę.',
  name_too_long: 'Nazwa może mieć najwyżej 80 znaków.',
  invalid_email: 'Podaj poprawny adres e-mail albo zostaw to pole puste.',
  email_taken: 'Ten adres e-mail ma już inny instruktor w tej szkole.',
  instructor_not_found: 'Nie znaleziono instruktora.',
  invalid_hours: 'Godziny pracy: koniec musi być później niż początek.',
  overlapping_hours: 'Godziny pracy w jednym dniu nie mogą na siebie nachodzić.',
  hours_in_past: 'Nowe godziny pracy mogą obowiązywać od dziś albo od dnia w przyszłości.',
  invalid_period: 'Podaj poprawny początek i koniec (koniec później niż początek).',
  period_in_past: 'Ten czas już minął.',
  period_too_long: 'Jeden wpis może trwać najwyżej rok.',
  exception_not_found: 'Nie znaleziono tego wpisu.',
  service_not_found: 'Nie znaleziono usługi.',
  invalid_duration: 'Długość lekcji: od 5 do 600 minut.',
  invalid_credit_cost: 'Jedna rezerwacja zdejmuje z konta od 1 do 10 lekcji.',
  invalid_price: 'Cena lekcji: od 0 do 10 000 zł.',
  last_service: 'Szkoła musi mieć co najmniej jedną aktywną usługę, inaczej nikt nie zarezerwuje lekcji.',
  invalid_slot_step: 'Początki lekcji co ile minut: od 5 do 240.',
  invalid_buffer: 'Przerwa po lekcji: od 0 do 240 minut.',
  invalid_min_gap: 'Najkrótsza przerwa w grafiku: od 0 do 600 minut.',
  invalid_min_notice: 'Wyprzedzenie rezerwacji: od 0 do 720 godzin.',
  invalid_max_advance: 'Rezerwacje naprzód: od 1 do 730 dni.',
  invalid_cancel_deadline: 'Termin odwołania: od 0 do 720 godzin przed lekcją.',
  invalid_trusted_limit: 'Domyślny limit zaufanej pary: od 0 do 20 lekcji.',
  invalid_payment_hold: 'Czas na płatność online: od 30 do 1440 minut (24 godziny).',
} as const;

export type SetupErrorCode = keyof typeof MESSAGES;

/** Odmowa przy zmianie ustawień; komunikat po polsku można pokazać użytkownikowi. */
export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SetupError';
  }
}

// --- Reguły grafiku (organization_settings) ------------------------------------------------------

/** Reguły grafiku, które szkoła ustawia w panelu. */
export interface ScheduleRules {
  backToBackSlots: boolean;
  slotStepMinutes: number;
  bufferMinutes: number;
  minGapMinutes: number;
  compactDays: boolean;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  cancelDeadlineHours: number;
  firstLessonPrepaid: boolean;
  /** Domyślny limit zejścia poniżej zera dla pary, która zostaje zaufana. */
  defaultTrustedCreditLimit: number;
  /** Jak długo termin pierwszej lekcji czeka na płatność online (Stripe: od 30 minut do 24 godzin). */
  paymentHoldMinutes: number;
  /** Zadania w tle: lekcja po swoim końcu zmienia się na odbytą. */
  autoCompleteLessons: boolean;
  /** Zadania w tle: nowa para po pierwszej odbytej lekcji staje się stała. */
  autoPromoteAfterFirstLesson: boolean;
}

type NumericRule = { [K in keyof ScheduleRules]: ScheduleRules[K] extends number ? K : never }[keyof ScheduleRules];

/** Dozwolone zakresy (jak ograniczenia CHECK w bazie, z rozsądnym górnym limitem tam, gdzie baza go nie ma). */
const RULE_LIMITS: Record<NumericRule, [min: number, max: number, error: SetupErrorCode]> = {
  slotStepMinutes: [5, 240, 'invalid_slot_step'],
  bufferMinutes: [0, 240, 'invalid_buffer'],
  minGapMinutes: [0, 600, 'invalid_min_gap'],
  minNoticeMinutes: [0, 720 * 60, 'invalid_min_notice'],
  maxAdvanceDays: [1, 730, 'invalid_max_advance'],
  cancelDeadlineHours: [0, 720, 'invalid_cancel_deadline'],
  defaultTrustedCreditLimit: [0, 20, 'invalid_trusted_limit'],
  paymentHoldMinutes: [30, 1440, 'invalid_payment_hold'],
};

/** Pierwszy błąd w regułach grafiku albo null, gdy wszystkie wartości są w dozwolonych zakresach. */
export function checkScheduleRules(rules: ScheduleRules): SetupErrorCode | null {
  for (const [key, [min, max, error]] of Object.entries(RULE_LIMITS) as [NumericRule, [number, number, SetupErrorCode]][]) {
    const value = rules[key];
    if (!Number.isInteger(value) || value < min || value > max) return error;
  }
  return null;
}

// --- Stałe godziny pracy (availability_rules) ------------------------------------------------------

/** Odcinek godzin pracy w tygodniu, w czasie lokalnym firmy. */
export interface WorkRange {
  /** 1 = poniedziałek … 7 = niedziela. */
  weekday: number;
  /** GG:MM. */
  start: string;
  end: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Pierwszy błąd w godzinach pracy albo null. Odcinki stykające się (10–12 i 12–14) są dozwolone. */
export function checkWorkRanges(ranges: WorkRange[]): SetupErrorCode | null {
  for (const r of ranges) {
    if (!Number.isInteger(r.weekday) || r.weekday < 1 || r.weekday > 7) return 'invalid_request';
    if (!TIME.test(r.start) || !TIME.test(r.end) || timeToMinutes(r.end) <= timeToMinutes(r.start)) return 'invalid_hours';
  }
  const sorted = [...ranges].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const [prev, next] = [sorted[i - 1]!, sorted[i]!];
    if (prev.weekday === next.weekday && next.start < prev.end) return 'overlapping_hours';
  }
  return null;
}

/** Godziny pracy obowiązujące od valid_from do valid_to (włącznie; null = bez końca). */
export interface HoursVersion {
  validFrom: string;
  validTo: string | null;
  ranges: WorkRange[];
}

// --- Wyjątki: urlop, wolne, dodatkowe godziny (availability_exceptions) -----------------------------

/** Okres wpisany w formularzu w czasie lokalnym firmy. Bez godzin: całe dni. */
export interface LocalPeriod {
  startDate: string;
  endDate: string;
  /** GG:MM; brak = od północy pierwszego dnia. */
  startTime?: string | null;
  /** GG:MM; brak = do północy po ostatnim dniu. */
  endTime?: string | null;
}

/**
 * Początek i koniec okresu w czasie bezwzględnym. Całe dni trwają od północy pierwszego dnia
 * do północy po ostatnim dniu (czasu lokalnego firmy, także przy zmianie czasu).
 */
export function periodInstants(period: LocalPeriod, timeZone: string): { startsAt: Date; endsAt: Date } {
  const { startDate, endDate } = period;
  const startTime = period.startTime || null;
  const endTime = period.endTime || null;
  if (!isLocalDate(startDate) || !isLocalDate(endDate)) throw new SetupError('invalid_period');
  if ((startTime && !TIME.test(startTime)) || (endTime && !TIME.test(endTime))) throw new SetupError('invalid_period');
  const startsAt = localToInstant(startDate, startTime ? timeToMinutes(startTime) : 0, timeZone);
  const endsAt = endTime ? localToInstant(endDate, timeToMinutes(endTime), timeZone) : localToInstant(addDays(endDate, 1), 0, timeZone);
  if (endsAt <= startsAt) throw new SetupError('invalid_period');
  return { startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
}

/** Opis okresu do listy, np. „pt., 11 grudnia, cały dzień”, „pon., 4 stycznia – pt., 8 stycznia”, „sob., 12 grudnia, 10:00–14:00”. */
export function periodLabel(startsAt: Date, endsAt: Date, timeZone: string): string {
  const day = (date: string) => formatShortDay(new Date(localToInstant(date, 12 * 60, timeZone)), timeZone);
  const [startDay, startTime] = [localDateOf(startsAt.getTime(), timeZone), localTimeOf(startsAt.getTime(), timeZone)];
  const [endDay, endTime] = [localDateOf(endsAt.getTime(), timeZone), localTimeOf(endsAt.getTime(), timeZone)];
  if (startTime === '00:00' && endTime === '00:00') {
    const lastDay = addDays(endDay, -1);
    return lastDay === startDay ? `${day(startDay)}, cały dzień` : `${day(startDay)} – ${day(lastDay)}`;
  }
  if (startDay === endDay) return `${day(startDay)}, ${startTime}–${endTime}`;
  return `${day(startDay)}, ${startTime} – ${day(endDay)}, ${endTime}`;
}

// --- Odczyt wszystkich ustawień do panelu ---------------------------------------------------------

export interface SetupException {
  id: string;
  kind: AvailabilityExceptionKind;
  label: string;
  note: string | null;
}

export interface SetupInstructor {
  id: string;
  name: string;
  /** Adres, którym instruktor loguje się, żeby zobaczyć swoje lekcje. */
  email: string | null;
  active: boolean;
  /** Godziny pracy obowiązujące dziś. */
  current: HoursVersion | null;
  /** Zmiany godzin zaplanowane od przyszłego dnia, od najbliższej. */
  planned: HoursVersion[];
  /** Urlopy, wolne i dodatkowe godziny, które jeszcze się nie skończyły. */
  exceptions: SetupException[];
  /** Zaplanowane lekcje (od teraz). */
  upcomingLessons: number;
}

export interface SetupService {
  id: string;
  name: string;
  durationMinutes: number;
  creditCost: number;
  /** Cena pojedynczej lekcji w groszach; null = bez ceny. */
  priceCents: number | null;
  active: boolean;
}

export interface SetupPackage {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
  active: boolean;
}

export interface ScheduleSetup {
  timeZone: string;
  today: string;
  rules: ScheduleRules;
  /** Najpierw aktywni, potem wyłączeni; w grupie według nazwy. */
  instructors: SetupInstructor[];
  services: SetupService[];
  /** Najpierw aktywne, w kolejności dodania. */
  packages: SetupPackage[];
  /** Waluta firmy, np. PLN. */
  currency: string;
}

const hhmm = (time: string) => time.slice(0, 5);
const byName = <T extends { name: string; active: boolean }>(a: T, b: T) =>
  Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'pl');

async function requireStaff(tx: Tx, ctx: FirmContext): Promise<void> {
  const actor = await actorOf(tx, ctx);
  if (!actor.isStaff) throw new SetupError('not_allowed');
}

async function audit(tx: Tx, ctx: FirmContext, action: string, entity: string, entityId: string | null, data: Json = {}) {
  await tx
    .insertInto('auditLog')
    .values({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action, entity, entityId, data: JSON.stringify(data) })
    .execute();
}

/** Wszystkie ustawienia grafiku szkoły do panelu (tylko dla szkoły). */
export function loadScheduleSetup(db: Database, ctx: FirmContext, now: Date = new Date()): Promise<ScheduleSetup> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const firm = await loadFirmRules(tx, ctx.organizationId);
    const timeZone = firm.timeZone;
    const today = localDateOf(now.getTime(), timeZone);

    const instructors = await tx
      .selectFrom('instructors as i')
      .leftJoin('users as u', 'u.id', 'i.userId')
      .select(['i.id', 'i.name', 'i.active', 'u.email'])
      .where('i.organizationId', '=', ctx.organizationId)
      .execute();
    const hours = await tx
      .selectFrom('availabilityRules')
      .select((eb) => [
        'instructorId',
        'weekday',
        'startTime',
        'endTime',
        eb.fn<string>('to_char', [eb.ref('validFrom'), eb.val('YYYY-MM-DD')]).as('validFrom'),
        eb.fn<string | null>('to_char', [eb.ref('validTo'), eb.val('YYYY-MM-DD')]).as('validTo'),
      ])
      .where('active', '=', true)
      .orderBy('weekday')
      .orderBy('startTime')
      .execute();
    const exceptions = await tx
      .selectFrom('availabilityExceptions')
      .select(['id', 'instructorId', 'kind', 'startsAt', 'endsAt', 'note'])
      .where('active', '=', true)
      .where('endsAt', '>', now)
      .orderBy('startsAt')
      .execute();
    const lessons = await tx
      .selectFrom('bookings')
      .select((eb) => ['instructorId', eb.fn.countAll<number>().as('count')])
      .where('status', 'in', ['pending_payment', 'confirmed'])
      .where('startsAt', '>=', now)
      .groupBy('instructorId')
      .execute();
    const services = await tx
      .selectFrom('services')
      .select(['id', 'name', 'durationMinutes', 'creditCost', 'priceCents', 'active'])
      .where('organizationId', '=', ctx.organizationId)
      .orderBy('active', 'desc') // najpierw aktywne, w kolejności dodania (jak w kalendarzu)
      .orderBy('createdAt')
      .orderBy('name')
      .execute();
    const packages = await tx
      .selectFrom('packages')
      .select(['id', 'name', 'credits', 'priceCents', 'active'])
      .where('organizationId', '=', ctx.organizationId)
      .orderBy('active', 'desc')
      .orderBy('createdAt')
      .execute();
    const { currency } = await tx
      .selectFrom('organizations')
      .select('currency')
      .where('id', '=', ctx.organizationId)
      .executeTakeFirstOrThrow();
    const settings = await tx
      .selectFrom('organizationSettings')
      .select([
        'backToBackSlots',
        'slotStepMinutes',
        'bufferMinutes',
        'minGapMinutes',
        'compactDays',
        'minNoticeMinutes',
        'maxAdvanceDays',
        'cancelDeadlineHours',
        'firstLessonPrepaid',
        'defaultTrustedCreditLimit',
        'paymentHoldMinutes',
        'autoCompleteLessons',
        'autoPromoteAfterFirstLesson',
      ])
      .executeTakeFirstOrThrow();

    return {
      timeZone,
      today,
      rules: settings,
      packages,
      currency,
      instructors: instructors
        .map((i): SetupInstructor => {
          const own = hours.filter((h) => h.instructorId === i.id);
          const toRange = (h: (typeof own)[number]): WorkRange => ({ weekday: h.weekday, start: hhmm(h.startTime), end: hhmm(h.endTime) });
          const current = own.filter((h) => h.validFrom <= today && (h.validTo === null || h.validTo >= today));
          const plannedStarts = [...new Set(own.filter((h) => h.validFrom > today).map((h) => h.validFrom))].sort();
          return {
            id: i.id,
            name: i.name,
            email: i.email,
            active: i.active,
            current:
              current.length > 0
                ? {
                    validFrom: current.map((h) => h.validFrom).sort().at(-1)!,
                    validTo: current.some((h) => h.validTo === null) ? null : current.map((h) => h.validTo!).sort().at(-1)!,
                    ranges: current.map(toRange),
                  }
                : null,
            planned: plannedStarts.map((validFrom) => {
              const version = own.filter((h) => h.validFrom === validFrom);
              return { validFrom, validTo: version[0]?.validTo ?? null, ranges: version.map(toRange) };
            }),
            exceptions: exceptions
              .filter((e) => e.instructorId === i.id)
              .map((e) => ({ id: e.id, kind: e.kind, label: periodLabel(e.startsAt, e.endsAt, timeZone), note: e.note })),
            upcomingLessons: Number(lessons.find((l) => l.instructorId === i.id)?.count ?? 0),
          };
        })
        .sort(byName),
      services,
    };
  });
}

// --- Instruktorzy ----------------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanName(name: string): string {
  const value = name.trim();
  if (!value) throw new SetupError('name_required');
  if (value.length > 80) throw new SetupError('name_too_long');
  return value;
}

function cleanEmail(email: string | null | undefined): string | null {
  const value = (email ?? '').trim();
  if (!value) return null;
  if (value.length > 254 || !EMAIL.test(value)) throw new SetupError('invalid_email');
  return value;
}

/**
 * Konto logowania dla adresu instruktora (to samo konto, jeśli adres już jest w systemie)
 * i rola instruktora w firmie, chyba że osoba ma już w niej rolę (np. właściciel, który sam uczy).
 */
async function instructorAccount(tx: Tx, ctx: FirmContext, instructorId: string | null, email: string): Promise<string> {
  await tx
    .insertInto('users')
    .values({ email })
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();
  const user = await tx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow();
  let taken = tx
    .selectFrom('instructors')
    .select('id')
    .where('organizationId', '=', ctx.organizationId)
    .where('userId', '=', user.id);
  if (instructorId) taken = taken.where('id', '!=', instructorId);
  if (await taken.executeTakeFirst()) throw new SetupError('email_taken');
  await tx
    .insertInto('memberships')
    .values({ organizationId: ctx.organizationId, userId: user.id, role: 'instructor' })
    .onConflict((oc) => oc.columns(['organizationId', 'userId']).doNothing())
    .execute();
  return user.id;
}

export interface InstructorInput {
  name: string;
  /** Opcjonalnie: adres, którym instruktor loguje się, żeby widzieć swoje lekcje. */
  email?: string | null;
}

/** Dodaje instruktora. Wolne terminy pojawią się po ustawieniu jego godzin pracy. */
export function addInstructor(db: Database, ctx: FirmContext, input: InstructorInput): Promise<{ id: string }> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const name = cleanName(input.name);
    const email = cleanEmail(input.email);
    const userId = email ? await instructorAccount(tx, ctx, null, email) : null;
    const row = await tx
      .insertInto('instructors')
      .values({ organizationId: ctx.organizationId, name, userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(tx, ctx, 'instructor.added', 'instructors', row.id, { name, email });
    return row;
  });
}

export interface InstructorUpdate extends InstructorInput {
  instructorId: string;
  /** Wyłączony instruktor znika z grafiku; jego lekcje i historia zostają. */
  active: boolean;
}

/** Zmienia nazwę, adres logowania albo wyłącza (włącza) instruktora. */
export function updateInstructor(db: Database, ctx: FirmContext, input: InstructorUpdate): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const name = cleanName(input.name);
    const email = cleanEmail(input.email);
    const instructor = await tx
      .selectFrom('instructors')
      .select('id')
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.instructorId)
      .forUpdate()
      .executeTakeFirst();
    if (!instructor) throw new SetupError('instructor_not_found');
    const userId = email ? await instructorAccount(tx, ctx, instructor.id, email) : null;
    await tx.updateTable('instructors').set({ name, userId, active: input.active }).where('id', '=', instructor.id).execute();
    await audit(tx, ctx, 'instructor.updated', 'instructors', instructor.id, { name, email, active: input.active });
  });
}

async function findInstructor(tx: Tx, ctx: FirmContext, instructorId: string): Promise<string> {
  const row = await tx
    .selectFrom('instructors')
    .select('id')
    .where('organizationId', '=', ctx.organizationId)
    .where('id', '=', instructorId)
    .executeTakeFirst();
  if (!row) throw new SetupError('instructor_not_found');
  return row.id;
}

// --- Godziny pracy ---------------------------------------------------------------------------------

export interface WeeklyHoursInput {
  instructorId: string;
  /** Od tego dnia (RRRR-MM-DD, dziś albo później) obowiązują nowe godziny. */
  validFrom: string;
  /** Pusta lista: od tego dnia instruktor nie ma stałych godzin pracy. */
  ranges: WorkRange[];
  now?: Date;
}

/**
 * Ustawia stałe godziny pracy instruktora od wybranego dnia. Godziny sprzed tego dnia kończą się
 * dzień wcześniej, a godziny zaplanowane od tego dnia lub później zastępują nowe (stare wyłączamy).
 */
export function setWeeklyHours(db: Database, ctx: FirmContext, input: WeeklyHoursInput): Promise<void> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const instructorId = await findInstructor(tx, ctx, input.instructorId);
    const { timeZone } = await loadFirmRules(tx, ctx.organizationId);
    if (!isLocalDate(input.validFrom)) throw new SetupError('invalid_request');
    if (input.validFrom < localDateOf(now.getTime(), timeZone)) throw new SetupError('hours_in_past');
    const error = checkWorkRanges(input.ranges);
    if (error) throw new SetupError(error);

    // Dzień jako typ date w bazie (bez przeliczania stref czasowych w aplikacji).
    const fromDay = sql<Date>`${input.validFrom}::date`;
    // Kolejne zmiany godzin tego instruktora czekają na siebie (blokada wiersza instruktora).
    await tx.selectFrom('instructors').select('id').where('id', '=', instructorId).forUpdate().execute();
    await tx
      .updateTable('availabilityRules')
      .set({ active: false })
      .where('instructorId', '=', instructorId)
      .where('active', '=', true)
      .where('validFrom', '>=', fromDay)
      .execute();
    await tx
      .updateTable('availabilityRules')
      .set({ validTo: addDays(input.validFrom, -1) })
      .where('instructorId', '=', instructorId)
      .where('active', '=', true)
      .where('validFrom', '<', fromDay)
      .where((eb) => eb.or([eb('validTo', 'is', null), eb('validTo', '>=', fromDay)]))
      .execute();
    if (input.ranges.length > 0) {
      await tx
        .insertInto('availabilityRules')
        .values(
          input.ranges.map((r) => ({
            organizationId: ctx.organizationId,
            instructorId,
            weekday: r.weekday,
            startTime: r.start,
            endTime: r.end,
            validFrom: input.validFrom,
          })),
        )
        .execute();
    }
    await audit(tx, ctx, 'availability.hours_set', 'instructors', instructorId, {
      validFrom: input.validFrom,
      ranges: input.ranges.map((r) => ({ ...r })),
    });
  });
}

// --- Urlop, wolne, dodatkowe godziny ---------------------------------------------------------------

export interface ExceptionInput {
  instructorId: string;
  kind: AvailabilityExceptionKind;
  period: LocalPeriod;
  note?: string | null;
  now?: Date;
}

/** Najdłuższy pojedynczy wpis (urlop, dodatkowe godziny). */
const MAX_EXCEPTION_DAYS = 366;

/**
 * Dodaje urlop albo wolne (unavailable) lub dodatkowe godziny (extra). Lekcje zarezerwowane
 * w czasie urlopu zostają; wynik podaje ich liczbę, żeby szkoła mogła je odwołać.
 */
export function addException(
  db: Database,
  ctx: FirmContext,
  input: ExceptionInput,
): Promise<{ id: string; lessonsInside: number }> {
  const now = input.now ?? new Date();
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    if (input.kind !== 'unavailable' && input.kind !== 'extra') throw new SetupError('invalid_request');
    const instructorId = await findInstructor(tx, ctx, input.instructorId);
    const { timeZone } = await loadFirmRules(tx, ctx.organizationId);
    const { startsAt, endsAt } = periodInstants(input.period, timeZone);
    if (endsAt <= now) throw new SetupError('period_in_past');
    if (endsAt.getTime() - startsAt.getTime() > MAX_EXCEPTION_DAYS * DAY) throw new SetupError('period_too_long');
    const note = (input.note ?? '').trim().slice(0, 200) || null;

    const row = await tx
      .insertInto('availabilityExceptions')
      .values({ organizationId: ctx.organizationId, instructorId, kind: input.kind, startsAt, endsAt, note, createdBy: ctx.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    let lessonsInside = 0;
    if (input.kind === 'unavailable') {
      const lessons = await tx
        .selectFrom('bookings')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('instructorId', '=', instructorId)
        .where('status', 'in', BLOCKING_STATUSES)
        .where('startsAt', '<', endsAt)
        .where('endsAt', '>', startsAt)
        .executeTakeFirst();
      lessonsInside = Number(lessons?.count ?? 0);
    }
    await audit(tx, ctx, 'availability.exception_added', 'availability_exceptions', row.id, {
      instructorId,
      kind: input.kind,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      note,
    });
    return { id: row.id, lessonsInside };
  });
}

/** Odwołuje urlop, wolne albo dodatkowe godziny: wpis zostaje w bazie jako wyłączony. */
export function cancelException(db: Database, ctx: FirmContext, input: { exceptionId: string }): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const result = await tx
      .updateTable('availabilityExceptions')
      .set({ active: false })
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.exceptionId)
      .where('active', '=', true)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new SetupError('exception_not_found');
    await audit(tx, ctx, 'availability.exception_cancelled', 'availability_exceptions', input.exceptionId);
  });
}

// --- Reguły grafiku --------------------------------------------------------------------------------

/** Zapisuje reguły grafiku. Działają od razu: wolne terminy liczą się już według nowych reguł. */
export function updateScheduleRules(db: Database, ctx: FirmContext, rules: ScheduleRules): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const error = checkScheduleRules(rules);
    if (error) throw new SetupError(error);
    const values: ScheduleRules = {
      backToBackSlots: Boolean(rules.backToBackSlots),
      slotStepMinutes: rules.slotStepMinutes,
      bufferMinutes: rules.bufferMinutes,
      minGapMinutes: rules.minGapMinutes,
      compactDays: Boolean(rules.compactDays),
      minNoticeMinutes: rules.minNoticeMinutes,
      maxAdvanceDays: rules.maxAdvanceDays,
      cancelDeadlineHours: rules.cancelDeadlineHours,
      firstLessonPrepaid: Boolean(rules.firstLessonPrepaid),
      defaultTrustedCreditLimit: rules.defaultTrustedCreditLimit,
      paymentHoldMinutes: rules.paymentHoldMinutes,
      autoCompleteLessons: Boolean(rules.autoCompleteLessons),
      autoPromoteAfterFirstLesson: Boolean(rules.autoPromoteAfterFirstLesson),
    };
    await tx.updateTable('organizationSettings').set(values).where('organizationId', '=', ctx.organizationId).execute();
    await audit(tx, ctx, 'settings.schedule_updated', 'organization_settings', ctx.organizationId, { ...values });
  });
}

// --- Usługi ----------------------------------------------------------------------------------------

export interface ServiceInput {
  name: string;
  durationMinutes: number;
  creditCost: number;
  /** Cena pojedynczej lekcji w groszach (0–10 000 zł); null = bez ceny; przy zmianie brak = bez zmiany. */
  priceCents?: number | null;
}

/** Najwyższa cena pojedynczej lekcji: 10 000 zł w groszach. */
const MAX_LESSON_PRICE_CENTS = 1_000_000;

function checkService(input: ServiceInput): void {
  const price = input.priceCents;
  if (price !== undefined && price !== null && (!Number.isInteger(price) || price < 0 || price > MAX_LESSON_PRICE_CENTS)) {
    throw new SetupError('invalid_price');
  }
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 600) {
    throw new SetupError('invalid_duration');
  }
  if (!Number.isInteger(input.creditCost) || input.creditCost < 1 || input.creditCost > 10) {
    throw new SetupError('invalid_credit_cost');
  }
}

/** Dodaje usługę (rodzaj lekcji). Od razu można ją rezerwować. */
export function addService(db: Database, ctx: FirmContext, input: ServiceInput): Promise<{ id: string }> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const name = cleanName(input.name);
    checkService(input);
    const row = await tx
      .insertInto('services')
      .values({
        organizationId: ctx.organizationId,
        name,
        durationMinutes: input.durationMinutes,
        creditCost: input.creditCost,
        priceCents: input.priceCents ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(tx, ctx, 'service.added', 'services', row.id, {
      name,
      durationMinutes: input.durationMinutes,
      creditCost: input.creditCost,
      priceCents: input.priceCents ?? null,
    });
    return row;
  });
}

export interface ServiceUpdate extends ServiceInput {
  serviceId: string;
  active: boolean;
}

/**
 * Zmienia usługę. Nowa długość i koszt dotyczą nowych rezerwacji; zarezerwowane lekcje zostają bez zmian.
 * Ostatniej aktywnej usługi nie można wyłączyć.
 */
export function updateService(db: Database, ctx: FirmContext, input: ServiceUpdate): Promise<void> {
  return withTenant(db, ctx, async (tx) => {
    await requireStaff(tx, ctx);
    const name = cleanName(input.name);
    checkService(input);
    // Blokada aktywnych usług: dwie osoby wyłączające naraz dwie ostatnie usługi nie wyłączą obu.
    const active = await tx
      .selectFrom('services')
      .select('id')
      .where('organizationId', '=', ctx.organizationId)
      .where('active', '=', true)
      .forUpdate()
      .execute();
    const service = await tx
      .selectFrom('services')
      .select(['id', 'active'])
      .where('organizationId', '=', ctx.organizationId)
      .where('id', '=', input.serviceId)
      .executeTakeFirst();
    if (!service) throw new SetupError('service_not_found');
    if (!input.active && service.active && active.length <= 1) throw new SetupError('last_service');
    await tx
      .updateTable('services')
      .set({
        name,
        durationMinutes: input.durationMinutes,
        creditCost: input.creditCost,
        active: input.active,
        ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
      })
      .where('id', '=', service.id)
      .execute();
    await audit(tx, ctx, 'service.updated', 'services', service.id, {
      name,
      durationMinutes: input.durationMinutes,
      creditCost: input.creditCost,
      priceCents: input.priceCents,
      active: input.active,
    });
  });
}
