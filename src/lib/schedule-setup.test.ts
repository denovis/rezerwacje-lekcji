// Ustawienia grafiku w panelu szkoły (zasady z docs/decyzje.md) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant().
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCredits,
  appTestDatabaseUrl,
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  createWeeklyHours,
} from '../../db/tests/helpers.ts';
import { bookLesson, cancelBooking, listFreeSlots, type FirmContext } from './bookings';
import { createDb, type Database } from './db';
import { listMyFirms } from './firms';
import { loadWeek } from './week';
import { localTimeOf, localToInstant, timeToMinutes } from './local-time';
import {
  addException,
  addInstructor,
  addService,
  cancelException,
  checkScheduleRules,
  checkWorkRanges,
  loadScheduleSetup,
  periodInstants,
  periodLabel,
  SetupError,
  setWeeklyHours,
  updateInstructor,
  updateScheduleRules,
  updateService,
  type ScheduleRules,
} from './schedule-setup';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11'; // czas zimowy (UTC+1)
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04'); // poniedziałek tydzień wcześniej

/** Domyślne reguły nowej firmy (jak w organization_settings). */
const DEFAULT_RULES: ScheduleRules = {
  backToBackSlots: true,
  slotStepMinutes: 30,
  bufferMinutes: 0,
  minGapMinutes: 0,
  compactDays: false,
  minNoticeMinutes: 1440,
  maxAdvanceDays: 60,
  cancelDeadlineHours: 24,
  firstLessonPrepaid: true,
  defaultTrustedCreditLimit: 1,
};

let owner: pg.Pool;
let db: Database;

beforeAll(() => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

interface Firm {
  orgId: string;
  ownerId: string;
  instructorId: string;
  serviceId: string;
  clientId: string;
  staff: FirmContext;
  client: FirmContext;
}

/** Osobna szkoła na każdy test: instruktorka Ola (codziennie 16:00–21:00), lekcja 45 minut, para z 5 lekcjami. */
async function createFirm(): Promise<Firm> {
  const orgId = await createOrg(owner);
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  const clientUser = await createUser(owner);
  const clientId = await createClient(owner, orgId, { userId: clientUser, status: 'regular' });
  await addCredits(owner, orgId, clientId, 5, ownerId);
  return {
    orgId,
    ownerId,
    instructorId,
    serviceId,
    clientId,
    staff: { organizationId: orgId, userId: ownerId },
    client: { organizationId: orgId, userId: clientUser },
  };
}

/** Osoba z rolą w szkole (np. admin, instruktor). */
async function member(firm: Firm, role: 'admin' | 'instructor'): Promise<FirmContext> {
  const userId = await createUser(owner);
  await owner.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [firm.orgId, userId, role]);
  return { organizationId: firm.orgId, userId };
}

/** Godziny wolnych terminów w danym dniu (GG:MM), dla jednego instruktora albo wszystkich. */
async function slotsOn(firm: Firm, day: string, options: { instructorId?: string; serviceId?: string } = {}): Promise<string[]> {
  const slots = await listFreeSlots(db, firm.staff, {
    serviceId: options.serviceId ?? firm.serviceId,
    from: day,
    to: day,
    instructorId: options.instructorId,
    now: NOW,
  });
  return slots.map((s) => localTimeOf(s.startsAt.getTime(), TZ));
}

/** Kod odmowy (SetupError) albo opis innego wyniku. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof SetupError ? err.code : `inny błąd: ${String(err)}`;
  }
  return 'brak odmowy';
}

function bookAsStaff(firm: Firm, time: string, day = MONDAY) {
  return bookLesson(db, firm.staff, {
    clientId: firm.clientId,
    instructorId: firm.instructorId,
    serviceId: firm.serviceId,
    startsAt: at(time, day),
    now: NOW,
  });
}

const ALL_DAY_SLOTS = ['16:00', '16:45', '17:30', '18:15', '19:00', '19:45'];

describe('Instruktorzy', () => {
  it('szkoła dodaje instruktora, a jego wolne terminy pojawiają się po ustawieniu godzin pracy', async () => {
    const firm = await createFirm();
    const { id } = await addInstructor(db, firm.staff, { name: '  Kasia  ' });
    expect(await slotsOn(firm, MONDAY, { instructorId: id })).toEqual([]);

    await setWeeklyHours(db, firm.staff, {
      instructorId: id,
      validFrom: '2027-01-04',
      ranges: [{ weekday: 1, start: '10:00', end: '12:00' }],
      now: NOW,
    });
    expect(await slotsOn(firm, MONDAY, { instructorId: id })).toEqual(['10:00', '10:45']);
    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.instructors.find((i) => i.id === id)).toMatchObject({ name: 'Kasia', active: true, email: null });
  });

  it('szkoła zmienia nazwę instruktora, a wolne terminy pokazują nową nazwę', async () => {
    const firm = await createFirm();
    await updateInstructor(db, firm.staff, { instructorId: firm.instructorId, name: 'Aleksandra', active: true });
    const slots = await listFreeSlots(db, firm.client, { serviceId: firm.serviceId, from: MONDAY, to: MONDAY, now: NOW });
    expect(new Set(slots.map((s) => s.instructorName))).toEqual(new Set(['Aleksandra']));
  });

  it('wyłączony instruktor znika z grafiku, a jego zaplanowane lekcje zostają', async () => {
    const firm = await createFirm();
    const lesson = await bookAsStaff(firm, '16:00');
    await updateInstructor(db, firm.staff, { instructorId: firm.instructorId, name: 'Ola', active: false });

    expect(await slotsOn(firm, MONDAY)).toEqual([]);
    const { rows } = await owner.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [lesson.bookingId]);
    expect(rows[0]?.status).toBe('confirmed');
    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.instructors.find((i) => i.id === firm.instructorId)).toMatchObject({ active: false, upcomingLessons: 1 });
  });

  it('instruktor z adresem e-mail loguje się tym adresem i widzi szkołę z rolą instruktora', async () => {
    const firm = await createFirm();
    const email = `kasia-${Date.now()}@example.com`;
    const { id } = await addInstructor(db, firm.staff, { name: 'Kasia', email });

    const { rows } = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const userId = rows[0]!.id;
    const firms = await listMyFirms(db, userId);
    expect(firms.find((f) => f.id === firm.orgId)?.roles).toEqual(['instructor']);
    const linked = await owner.query<{ user_id: string }>('SELECT user_id FROM instructors WHERE id = $1', [id]);
    expect(linked.rows[0]?.user_id).toBe(userId);
  });

  it('właściciel, który sam uczy, po połączeniu z instruktorem zostaje właścicielem', async () => {
    const firm = await createFirm();
    const { rows } = await owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [firm.ownerId]);
    await updateInstructor(db, firm.staff, { instructorId: firm.instructorId, name: 'Ola', email: rows[0]!.email, active: true });

    const firms = await listMyFirms(db, firm.ownerId);
    expect(firms.find((f) => f.id === firm.orgId)?.roles).toEqual(['owner']);
    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.instructors[0]?.email).toBe(rows[0]!.email);
  });

  it('jeden adres e-mail nie może mieć dwóch instruktorów w tej samej szkole (bez względu na wielkość liter)', async () => {
    const firm = await createFirm();
    const email = `basia-${Date.now()}@example.com`;
    await addInstructor(db, firm.staff, { name: 'Basia', email });
    expect(await refusal(addInstructor(db, firm.staff, { name: 'Basia 2', email: email.toUpperCase() }))).toBe('email_taken');
    expect(await refusal(addInstructor(db, firm.staff, { name: 'Ktoś', email: 'to-nie-adres' }))).toBe('invalid_email');
    expect(await refusal(addInstructor(db, firm.staff, { name: '   ' }))).toBe('name_required');
  });
});

describe('Stałe godziny pracy', () => {
  it('nowe godziny pracy obowiązują od wybranego dnia, a dni wcześniej zostają bez zmian', async () => {
    const firm = await createFirm();
    await setWeeklyHours(db, firm.staff, {
      instructorId: firm.instructorId,
      validFrom: MONDAY,
      ranges: [{ weekday: 1, start: '10:00', end: '12:00' }],
      now: NOW,
    });

    expect(await slotsOn(firm, '2027-01-05')).toEqual(ALL_DAY_SLOTS); // wtorek przed zmianą
    expect(await slotsOn(firm, MONDAY)).toEqual(['10:00', '10:45']);
    expect(await slotsOn(firm, '2027-01-12')).toEqual([]); // nowe godziny nie mają wtorku

    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    const ola = setup.instructors[0]!;
    expect(ola.current).toMatchObject({ validFrom: '2020-01-01', validTo: '2027-01-10' });
    expect(ola.current?.ranges).toHaveLength(7);
    expect(ola.planned).toEqual([{ validFrom: MONDAY, validTo: null, ranges: [{ weekday: 1, start: '10:00', end: '12:00' }] }]);
  });

  it('zmiana godzin od wcześniejszego dnia zastępuje godziny zaplanowane na później, a stare wpisy zostają wyłączone', async () => {
    const firm = await createFirm();
    const set = (validFrom: string, start: string, end: string) =>
      setWeeklyHours(db, firm.staff, { instructorId: firm.instructorId, validFrom, ranges: [{ weekday: 1, start, end }], now: NOW });
    await set(MONDAY, '10:00', '12:00');
    await set('2027-01-06', '18:00', '20:00');

    expect(await slotsOn(firm, MONDAY)).toEqual(['18:00', '18:45']);
    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.instructors[0]?.planned.map((p) => p.validFrom)).toEqual(['2027-01-06']);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM availability_rules WHERE instructor_id = $1 AND NOT active AND start_time = '10:00'",
      [firm.instructorId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('pusta lista godzin: od wybranego dnia instruktor nie ma stałych godzin pracy', async () => {
    const firm = await createFirm();
    await setWeeklyHours(db, firm.staff, { instructorId: firm.instructorId, validFrom: MONDAY, ranges: [], now: NOW });
    expect(await slotsOn(firm, MONDAY)).toEqual([]);
    expect(await slotsOn(firm, '2027-01-08')).toEqual(ALL_DAY_SLOTS);
  });

  it('godzin pracy nie można zmienić wstecz', async () => {
    const firm = await createFirm();
    const attempt = setWeeklyHours(db, firm.staff, {
      instructorId: firm.instructorId,
      validFrom: '2027-01-03',
      ranges: [{ weekday: 1, start: '10:00', end: '12:00' }],
      now: NOW,
    });
    expect(await refusal(attempt)).toBe('hours_in_past');
  });

  it('godziny pracy w jednym dniu nie mogą na siebie nachodzić, ale mogą się stykać', async () => {
    expect(
      checkWorkRanges([
        { weekday: 1, start: '10:00', end: '12:00' },
        { weekday: 1, start: '11:00', end: '13:00' },
      ]),
    ).toBe('overlapping_hours');
    expect(
      checkWorkRanges([
        { weekday: 1, start: '10:00', end: '12:00' },
        { weekday: 1, start: '12:00', end: '14:00' },
        { weekday: 2, start: '11:00', end: '13:00' },
      ]),
    ).toBeNull();

    const firm = await createFirm();
    const attempt = setWeeklyHours(db, firm.staff, {
      instructorId: firm.instructorId,
      validFrom: MONDAY,
      ranges: [
        { weekday: 3, start: '16:00', end: '20:00' },
        { weekday: 3, start: '19:00', end: '21:00' },
      ],
      now: NOW,
    });
    expect(await refusal(attempt)).toBe('overlapping_hours');
    expect(await slotsOn(firm, MONDAY)).toEqual(ALL_DAY_SLOTS); // nic się nie zmieniło
  });

  it('koniec godzin pracy musi być później niż początek', () => {
    expect(checkWorkRanges([{ weekday: 1, start: '12:00', end: '12:00' }])).toBe('invalid_hours');
    expect(checkWorkRanges([{ weekday: 1, start: '18:00', end: '16:00' }])).toBe('invalid_hours');
    expect(checkWorkRanges([{ weekday: 8, start: '10:00', end: '12:00' }])).toBe('invalid_request');
  });
});

describe('Urlop, wolne i dodatkowe godziny', () => {
  it('urlop na całe dni trwa od północy pierwszego dnia do północy po ostatnim dniu, także przy zmianie czasu', () => {
    const { startsAt, endsAt } = periodInstants({ startDate: '2027-03-27', endDate: '2027-03-28' }, TZ);
    expect(startsAt.toISOString()).toBe('2027-03-26T23:00:00.000Z'); // 27 marca, 00:00 czasu zimowego
    expect(endsAt.toISOString()).toBe('2027-03-28T22:00:00.000Z'); // 29 marca, 00:00 czasu letniego
  });

  it('urlop usuwa wolne terminy, a lekcje w tym czasie zostają i szkoła dostaje ich liczbę', async () => {
    const firm = await createFirm();
    const lesson = await bookAsStaff(firm, '16:00');
    const result = await addException(db, firm.staff, {
      instructorId: firm.instructorId,
      kind: 'unavailable',
      period: { startDate: MONDAY, endDate: '2027-01-12' },
      note: 'Urlop',
      now: NOW,
    });

    expect(result.lessonsInside).toBe(1);
    expect(await slotsOn(firm, MONDAY)).toEqual([]);
    expect(await slotsOn(firm, '2027-01-12')).toEqual([]);
    expect(await slotsOn(firm, '2027-01-13')).toEqual(ALL_DAY_SLOTS);
    const { rows } = await owner.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [lesson.bookingId]);
    expect(rows[0]?.status).toBe('confirmed');
  });

  it('wolne na część dnia usuwa tylko te godziny', async () => {
    const firm = await createFirm();
    await addException(db, firm.staff, {
      instructorId: firm.instructorId,
      kind: 'unavailable',
      period: { startDate: MONDAY, endDate: MONDAY, startTime: '16:00', endTime: '18:00' },
      now: NOW,
    });
    expect(await slotsOn(firm, MONDAY)).toEqual(['18:00', '18:45', '19:30', '20:15']);
  });

  it('dodatkowe godziny dodają wolne terminy poza stałymi godzinami', async () => {
    const firm = await createFirm();
    await addException(db, firm.staff, {
      instructorId: firm.instructorId,
      kind: 'extra',
      period: { startDate: '2027-01-16', endDate: '2027-01-16', startTime: '10:00', endTime: '12:00' },
      now: NOW,
    });
    expect(await slotsOn(firm, '2027-01-16')).toEqual(['10:00', '10:45', ...ALL_DAY_SLOTS]);
  });

  it('odwołany urlop przywraca wolne terminy, a wpis zostaje w bazie jako wyłączony', async () => {
    const firm = await createFirm();
    const { id } = await addException(db, firm.staff, {
      instructorId: firm.instructorId,
      kind: 'unavailable',
      period: { startDate: MONDAY, endDate: MONDAY },
      now: NOW,
    });
    await cancelException(db, firm.staff, { exceptionId: id });

    expect(await slotsOn(firm, MONDAY)).toEqual(ALL_DAY_SLOTS);
    const { rows } = await owner.query<{ active: boolean }>('SELECT active FROM availability_exceptions WHERE id = $1', [id]);
    expect(rows).toEqual([{ active: false }]);
    expect(await refusal(cancelException(db, firm.staff, { exceptionId: id }))).toBe('exception_not_found');
  });

  it('nie można dodać urlopu, który już minął, ani takiego, który kończy się przed początkiem', async () => {
    const firm = await createFirm();
    const add = (startDate: string, endDate: string) =>
      addException(db, firm.staff, { instructorId: firm.instructorId, kind: 'unavailable', period: { startDate, endDate }, now: NOW });
    expect(await refusal(add('2027-01-01', '2027-01-02'))).toBe('period_in_past');
    expect(await refusal(add('2027-01-12', '2027-01-11'))).toBe('invalid_period');
    expect(await refusal(add('2027-01-12', '2028-02-11'))).toBe('period_too_long');
  });

  it('ustawienia pokazują urlopy i dodatkowe godziny, które jeszcze się nie skończyły, z czytelnym opisem', async () => {
    expect(periodLabel(at('00:00'), at('00:00', '2027-01-12'), TZ)).toBe('pon., 11 stycznia, cały dzień');
    expect(periodLabel(at('00:00'), at('00:00', '2027-01-14'), TZ)).toBe('pon., 11 stycznia – śr., 13 stycznia');
    expect(periodLabel(at('10:00', '2027-01-16'), at('12:00', '2027-01-16'), TZ)).toBe('sob., 16 stycznia, 10:00–12:00');

    const firm = await createFirm();
    await addException(db, firm.staff, {
      instructorId: firm.instructorId,
      kind: 'extra',
      period: { startDate: '2027-01-16', endDate: '2027-01-16', startTime: '10:00', endTime: '12:00' },
      note: 'Sobota przed ślubem',
      now: NOW,
    });
    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.instructors[0]?.exceptions).toEqual([
      { id: expect.any(String), kind: 'extra', label: 'sob., 16 stycznia, 10:00–12:00', note: 'Sobota przed ślubem' },
    ]);
    const later = await loadScheduleSetup(db, firm.staff, at('12:00', '2027-01-16'));
    expect(later.instructors[0]?.exceptions).toEqual([]);
  });
});

describe('Reguły grafiku', () => {
  it('zmiana reguł grafiku od razu zmienia wolne terminy: przy 15 minutach przerwy lekcje zaczynają się co godzinę', async () => {
    const firm = await createFirm();
    await updateScheduleRules(db, firm.staff, { ...DEFAULT_RULES, bufferMinutes: 15 });
    expect(await slotsOn(firm, MONDAY)).toEqual(['16:00', '17:00', '18:00', '19:00', '20:00']);
    expect((await loadScheduleSetup(db, firm.staff, NOW)).rules).toEqual({ ...DEFAULT_RULES, bufferMinutes: 15 });
  });

  it('dłuższy termin odwołania z ustawień od razu dotyczy odwołań', async () => {
    const firm = await createFirm();
    const lesson = await bookAsStaff(firm, '16:00');
    await updateScheduleRules(db, firm.staff, { ...DEFAULT_RULES, cancelDeadlineHours: 48 });
    const result = await cancelBooking(db, firm.client, { bookingId: lesson.bookingId, now: at('10:00', '2027-01-10') });
    expect(result.status).toBe('late_cancelled');
  });

  it('reguły grafiku muszą mieścić się w dozwolonych zakresach', async () => {
    expect(checkScheduleRules(DEFAULT_RULES)).toBeNull();
    expect(checkScheduleRules({ ...DEFAULT_RULES, bufferMinutes: -5 })).toBe('invalid_buffer');
    expect(checkScheduleRules({ ...DEFAULT_RULES, slotStepMinutes: 2.5 })).toBe('invalid_slot_step');
    expect(checkScheduleRules({ ...DEFAULT_RULES, maxAdvanceDays: 0 })).toBe('invalid_max_advance');
    expect(checkScheduleRules({ ...DEFAULT_RULES, minNoticeMinutes: 721 * 60 })).toBe('invalid_min_notice');
    expect(checkScheduleRules({ ...DEFAULT_RULES, cancelDeadlineHours: 1000 })).toBe('invalid_cancel_deadline');
    expect(checkScheduleRules({ ...DEFAULT_RULES, defaultTrustedCreditLimit: 21 })).toBe('invalid_trusted_limit');

    const firm = await createFirm();
    expect(await refusal(updateScheduleRules(db, firm.staff, { ...DEFAULT_RULES, minGapMinutes: 601 }))).toBe('invalid_min_gap');
    expect((await loadScheduleSetup(db, firm.staff, NOW)).rules).toEqual(DEFAULT_RULES);
  });
});

describe('Usługi', () => {
  it('nowa usługa od razu ma wolne terminy według swojej długości', async () => {
    const firm = await createFirm();
    const { id } = await addService(db, firm.staff, { name: 'Lekcja 90 minut', durationMinutes: 90, creditCost: 2 });
    expect(await slotsOn(firm, MONDAY, { serviceId: id })).toEqual(['16:00', '17:30', '19:00']);
  });

  it('nowa usługa nie zmienia domyślnej usługi w kalendarzu: domyślna jest pierwsza dodana', async () => {
    const firm = await createFirm();
    const { id } = await addService(db, firm.staff, { name: 'A to krótka lekcja', durationMinutes: 30, creditCost: 1 });
    const week = await loadWeek(db, firm.client, { week: MONDAY, now: NOW });
    expect(week?.service?.id).toBe(firm.serviceId);
    expect(week?.services.map((s) => s.id)).toEqual([firm.serviceId, id]);
  });

  it('zmiana długości usługi dotyczy nowych rezerwacji, a zarezerwowane lekcje zostają bez zmian', async () => {
    const firm = await createFirm();
    const lesson = await bookAsStaff(firm, '16:00');
    await updateService(db, firm.staff, { serviceId: firm.serviceId, name: 'Lekcja', durationMinutes: 60, creditCost: 1, active: true });

    const { rows } = await owner.query<{ ends_at: Date }>('SELECT ends_at FROM bookings WHERE id = $1', [lesson.bookingId]);
    expect(rows[0]?.ends_at).toEqual(at('16:45'));
    expect(await slotsOn(firm, MONDAY)).toEqual(['16:45', '17:45', '18:45', '19:45']);
  });

  it('nie można wyłączyć ostatniej aktywnej usługi', async () => {
    const firm = await createFirm();
    const off = (serviceId: string) =>
      updateService(db, firm.staff, { serviceId, name: 'Lekcja', durationMinutes: 45, creditCost: 1, active: false });
    expect(await refusal(off(firm.serviceId))).toBe('last_service');

    const { id } = await addService(db, firm.staff, { name: 'Lekcja 60 minut', durationMinutes: 60, creditCost: 1 });
    await off(firm.serviceId);
    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.services.map((s) => [s.id, s.active])).toEqual([
      [id, true],
      [firm.serviceId, false],
    ]);
    expect(await refusal(off(id))).toBe('last_service');
  });

  it('długość lekcji i koszt w lekcjach muszą mieścić się w zakresie', async () => {
    const firm = await createFirm();
    expect(await refusal(addService(db, firm.staff, { name: 'Krótka', durationMinutes: 3, creditCost: 1 }))).toBe('invalid_duration');
    expect(await refusal(addService(db, firm.staff, { name: 'Darmowa', durationMinutes: 45, creditCost: 0 }))).toBe(
      'invalid_credit_cost',
    );
  });
});

describe('Kto zmienia ustawienia grafiku', () => {
  it('ustawienia grafiku widzi i zmienia tylko właściciel albo administrator: klient i instruktor dostają odmowę', async () => {
    const firm = await createFirm();
    const instructor = await member(firm, 'instructor');
    for (const ctx of [firm.client, instructor]) {
      expect(await refusal(loadScheduleSetup(db, ctx, NOW))).toBe('not_allowed');
      expect(await refusal(updateScheduleRules(db, ctx, { ...DEFAULT_RULES, bufferMinutes: 30 }))).toBe('not_allowed');
      expect(await refusal(addInstructor(db, ctx, { name: 'Ktoś' }))).toBe('not_allowed');
      expect(
        await refusal(
          setWeeklyHours(db, ctx, { instructorId: firm.instructorId, validFrom: MONDAY, ranges: [], now: NOW }),
        ),
      ).toBe('not_allowed');
    }
    expect(await slotsOn(firm, MONDAY)).toEqual(ALL_DAY_SLOTS);
  });

  it('administrator zmienia ustawienia grafiku tak samo jak właściciel', async () => {
    const firm = await createFirm();
    const admin = await member(firm, 'admin');
    await addService(db, admin, { name: 'Lekcja 60 minut', durationMinutes: 60, creditCost: 1 });
    await updateScheduleRules(db, admin, { ...DEFAULT_RULES, maxAdvanceDays: 30 });
    expect((await loadScheduleSetup(db, admin, NOW)).services).toHaveLength(2);
  });

  it('szkoła nie zmieni instruktora, usługi ani urlopu innej firmy', async () => {
    const firm = await createFirm();
    const other = await createFirm();
    const { id: otherException } = await addException(db, other.staff, {
      instructorId: other.instructorId,
      kind: 'unavailable',
      period: { startDate: MONDAY, endDate: MONDAY },
      now: NOW,
    });

    expect(
      await refusal(updateInstructor(db, firm.staff, { instructorId: other.instructorId, name: 'Przejęta', active: false })),
    ).toBe('instructor_not_found');
    expect(
      await refusal(
        setWeeklyHours(db, firm.staff, { instructorId: other.instructorId, validFrom: MONDAY, ranges: [], now: NOW }),
      ),
    ).toBe('instructor_not_found');
    expect(
      await refusal(
        updateService(db, firm.staff, { serviceId: other.serviceId, name: 'X', durationMinutes: 45, creditCost: 1, active: true }),
      ),
    ).toBe('service_not_found');
    expect(await refusal(cancelException(db, firm.staff, { exceptionId: otherException }))).toBe('exception_not_found');
    expect(await slotsOn(other, '2027-01-12')).toEqual(ALL_DAY_SLOTS);
  });

  it('każda zmiana ustawień grafiku trafia do dziennika z autorem', async () => {
    const firm = await createFirm();
    await updateScheduleRules(db, firm.staff, { ...DEFAULT_RULES, bufferMinutes: 10 });
    await addInstructor(db, firm.staff, { name: 'Kasia' });
    const { rows } = await owner.query<{ action: string; actor_user_id: string }>(
      'SELECT action, actor_user_id FROM audit_log WHERE organization_id = $1 ORDER BY created_at',
      [firm.orgId],
    );
    expect(rows).toEqual([
      { action: 'settings.schedule_updated', actor_user_id: firm.ownerId },
      { action: 'instructor.added', actor_user_id: firm.ownerId },
    ]);
  });
});
