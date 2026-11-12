// Kalendarz tygodniowy w panelu: co widzi klient, a co szkoła (prawdziwa baza, rola app_user).
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
  insertBooking,
} from '../../db/tests/helpers.ts';
import type { FirmContext } from './bookings';
import { createDb, type Database } from './db';
import { localToInstant, timeToMinutes } from './local-time';
import { loadWeek } from './week';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11'; // czas zimowy (UTC+1)
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04'); // tydzień wcześniej

let owner: pg.Pool;
let db: Database;
let staff: FirmContext;
let asAnna: FirmContext;
let asInstructor: FirmContext;
let anna: string;
let ewa: string;

beforeAll(async () => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
  const orgId = await createOrg(owner, 'Szkoła Tanga');
  const ownerId = await createUser(owner);
  const instructorUser = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'instructor')", [
    orgId,
    ownerId,
    instructorUser,
  ]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId); // codziennie 16:00–21:00
  const serviceId = await createService(owner, orgId, 45);
  const annaUser = await createUser(owner);
  anna = await createClient(owner, orgId, { userId: annaUser, status: 'regular' });
  ewa = await createClient(owner, orgId, { userId: await createUser(owner), status: 'regular' });
  await addCredits(owner, orgId, anna, 3, ownerId);
  for (const [clientId, start, end] of [
    [anna, '16:00', '16:45'],
    [ewa, '17:30', '18:15'],
  ] as const) {
    await insertBooking(owner, {
      orgId,
      instructorId,
      clientId,
      serviceId,
      start: at(start).toISOString(),
      end: at(end).toISOString(),
    });
  }
  // Lekcja wpisana przez szkołę w sobotę poza godzinami pracy.
  await insertBooking(owner, {
    orgId,
    instructorId,
    clientId: ewa,
    serviceId,
    start: at('12:00', '2027-01-16').toISOString(),
    end: at('12:45', '2027-01-16').toISOString(),
  });
  staff = { organizationId: orgId, userId: ownerId };
  asAnna = { organizationId: orgId, userId: annaUser };
  asInstructor = { organizationId: orgId, userId: instructorUser };
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

describe('Kalendarz tygodniowy', () => {
  it('kalendarz pokazuje cały tydzień od poniedziałku do niedzieli, także gdy w adresie jest środa', async () => {
    const week = await loadWeek(db, asAnna, { week: '2027-01-13', now: NOW });
    expect(week?.weekStart).toBe(MONDAY);
    expect(week?.days.map((d) => d.date)).toEqual([
      '2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15', '2027-01-16', '2027-01-17',
    ]);
    expect(week?.title).toBe('11–17 stycznia 2027');
    expect([week?.previousWeek, week?.nextWeek]).toEqual(['2027-01-04', '2027-01-18']);
  });

  it('klient widzi w kalendarzu swoje lekcje i wolne terminy, ale nie lekcje innych par', async () => {
    const week = await loadWeek(db, asAnna, { week: MONDAY, now: NOW });
    expect(week?.lessons.map((l) => [l.date, l.timeLabel])).toEqual([[MONDAY, '16:00–16:45']]);
    // Termin pary Ewy (17:30–18:15) nie jest wolny, a jej nazwiska klient nie widzi.
    const mondaySlots = week?.slots.filter((s) => s.date === MONDAY).map((s) => s.timeLabel);
    expect(mondaySlots).toEqual(['16:45–17:30', '18:15–19:00', '19:00–19:45', '19:45–20:30']);
    expect(week?.client).toMatchObject({ id: anna, balance: 3, balanceLabel: '3 lekcje' });
    expect(week?.upcoming).toMatchObject({ count: 1, nextWeek: MONDAY });
    expect(week?.clients).toEqual([]);
  });

  it('w kalendarzu lekcję można odwołać ze zwrotem do terminu odwołania, potem już bez zwrotu, a po jej początku wcale', async () => {
    const cancelAt = async (now: Date) => (await loadWeek(db, asAnna, { week: MONDAY, now }))?.lessons[0]?.cancel;
    expect(await cancelAt(NOW)).toEqual({ refundable: true, deadlineLabel: '10 stycznia, godz. 16:00' });
    expect(await cancelAt(at('10:00'))).toMatchObject({ refundable: false });
    expect(await cancelAt(at('16:10'))).toBeNull();
  });

  it('szkoła widzi w kalendarzu lekcje wszystkich klientów i wybiera klienta z listy z saldem', async () => {
    const week = await loadWeek(db, staff, { week: MONDAY, now: NOW });
    expect(week?.isStaff).toBe(true);
    expect(week?.lessons.map((l) => [l.date, l.timeLabel])).toEqual([
      [MONDAY, '16:00–16:45'],
      [MONDAY, '17:30–18:15'],
      ['2027-01-16', '12:00–12:45'],
    ]);
    expect(week?.clients.map((c) => [c.id, c.balance])).toEqual(
      expect.arrayContaining([
        [anna, 3],
        [ewa, 0],
      ]),
    );
  });

  it('szkoła widzi w kalendarzu oznaczanie nieobecności dopiero od początku lekcji, a klient wcale', async () => {
    const staffWeek = await loadWeek(db, staff, { week: MONDAY, now: at('16:10') });
    expect(staffWeek?.lessons.filter((l) => l.date === MONDAY).map((l) => [l.timeLabel, l.noShow])).toEqual([
      ['16:00–16:45', 'mark'],
      ['17:30–18:15', null],
    ]);
    const clientWeek = await loadWeek(db, asAnna, { week: MONDAY, now: at('16:10') });
    expect(clientWeek?.lessons.map((l) => l.noShow)).toEqual([null]);
  });

  it('godziny w kalendarzu obejmują godziny pracy i lekcję wpisaną poza nimi', async () => {
    const week = await loadWeek(db, staff, { week: MONDAY, now: NOW });
    expect(week?.range).toEqual({ start: 12 * 60, end: 21 * 60 });
    const nextWeek = await loadWeek(db, staff, { week: '2027-01-18', now: NOW });
    expect(nextWeek?.range).toEqual({ start: 16 * 60, end: 21 * 60 });
  });

  it('instruktor bez połączonego konta nie ma kalendarza', async () => {
    expect(await loadWeek(db, asInstructor, { week: MONDAY, now: NOW })).toBeNull();
  });

  it('instruktor widzi w kalendarzu tylko lekcje, które prowadzi: bez wolnych terminów i bez odwoływania', async () => {
    const { basia, ctx } = await instructorWithAccount('Basia');
    const week = await loadWeek(db, ctx, { week: OTHER_WEEK, now: NOW });

    expect(week?.isInstructor).toBe(true);
    expect(week?.isStaff).toBe(false);
    expect(week?.lessons.map((l) => [l.timeLabel, l.clientName, l.instructorName])).toEqual([['17:00–17:45', 'Anna i Piotr', 'Basia']]);
    expect(week?.lessons[0]?.cancel).toBeNull();
    expect(week?.slots).toEqual([]);
    expect([week?.service, week?.services, week?.clients]).toEqual([null, [], []]);
    expect(week?.upcoming).toMatchObject({ count: 1, nextWeek: OTHER_WEEK });
    // Siatka bez godzin pracy innych instruktorów: Basia nie ma stałych godzin, więc tylko jej lekcja.
    expect(week?.range).toEqual({ start: 17 * 60, end: 18 * 60 });

    // Szkoła widzi lekcje obu instruktorów w tym tygodniu.
    const staffWeek = await loadWeek(db, staff, { week: OTHER_WEEK, now: NOW });
    expect(staffWeek?.lessons.map((l) => l.instructorName)).toEqual(['Ola', 'Basia']);

    // Wyłączony instruktor nie ma już kalendarza.
    await owner.query('UPDATE instructors SET active = false WHERE id = $1', [basia]);
    expect(await loadWeek(db, ctx, { week: OTHER_WEEK, now: NOW })).toBeNull();
  });
});

const OTHER_WEEK = '2027-01-25';

/** Instruktor z kontem logowania (rola instruktora) i lekcją w tygodniu OTHER_WEEK; Ola ma w tym tygodniu inną lekcję. */
async function instructorWithAccount(name: string): Promise<{ basia: string; ctx: FirmContext }> {
  const orgId = staff.organizationId;
  const userId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'instructor')", [orgId, userId]);
  const basia = await createInstructor(owner, orgId, name);
  await owner.query('UPDATE instructors SET user_id = $1 WHERE id = $2', [userId, basia]);
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM services WHERE organization_id = $1 LIMIT 1',
    [orgId],
  );
  const serviceId = rows[0]!.id;
  const ola = (await owner.query<{ id: string }>("SELECT id FROM instructors WHERE organization_id = $1 AND name = 'Ola'", [orgId])).rows[0]!.id;
  for (const [instructorId, clientId, start, end] of [
    [ola, ewa, '16:00', '16:45'],
    [basia, anna, '17:00', '17:45'],
  ] as const) {
    await insertBooking(owner, {
      orgId,
      instructorId,
      clientId,
      serviceId,
      start: at(start, OTHER_WEEK).toISOString(),
      end: at(end, OTHER_WEEK).toISOString(),
    });
  }
  return { basia, ctx: { organizationId: orgId, userId } };
}
