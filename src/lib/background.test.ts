// Zadania w tle (zasady z docs/decyzje.md, „Zadania w tle”) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant() osobno dla każdej firmy.
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
import { describeReport, runAllFirms, runFirmTasks } from './background';
import { bookLesson, type FirmContext } from './bookings';
import { markNoShow } from './clients';
import { createDb, type Database } from './db';
import { localToInstant, timeToMinutes } from './local-time';
import { handleCheckoutEvent } from './payments';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11'; // czas zimowy (UTC+1)
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04'); // tydzień wcześniej
const MINUTE = 60_000;

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
  staff: FirmContext;
}

/** Osobna szkoła na każdy test: właściciel, instruktorka (codziennie 16:00–21:00), lekcja 45 minut za 200 zł. */
async function createFirm(settings: { autoComplete?: boolean; autoPromote?: boolean } = {}): Promise<Firm> {
  const orgId = await createOrg(owner);
  await owner.query(
    'UPDATE organization_settings SET auto_complete_lessons = $2, auto_promote_after_first_lesson = $3 WHERE organization_id = $1',
    [orgId, settings.autoComplete ?? true, settings.autoPromote ?? true],
  );
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  return { orgId, ownerId, instructorId, serviceId, staff: { organizationId: orgId, userId: ownerId } };
}

/** Lekcja 45 minut w poniedziałek o podanej godzinie. */
async function lesson(firm: Firm, clientId: string, time: string, status = 'confirmed'): Promise<string> {
  const start = at(time);
  const { rows } = await insertBooking(owner, {
    orgId: firm.orgId,
    instructorId: firm.instructorId,
    clientId,
    serviceId: firm.serviceId,
    start: start.toISOString(),
    end: new Date(start.getTime() + 45 * MINUTE).toISOString(),
    status,
  });
  return rows[0]!.id;
}

async function bookingStatus(id: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]);
  return rows[0]?.status;
}

async function clientRow(id: string) {
  const { rows } = await owner.query<{ status: string; credit_limit: number }>(
    'SELECT status, credit_limit FROM clients WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function auditActions(orgId: string) {
  const { rows } = await owner.query<{ action: string; entity_id: string; actor_user_id: string | null }>(
    "SELECT action, entity_id, actor_user_id FROM audit_log WHERE organization_id = $1 AND action IN ('booking.hold_expired', 'booking.completed', 'client.promoted') ORDER BY action",
    [orgId],
  );
  return rows;
}

/** Nowa para z kontem, która rezerwuje pierwszą lekcję z płatnością online (termin czeka na płatność). */
async function heldFirstLesson(firm: Firm) {
  const userId = await createUser(owner);
  const clientId = await createClient(owner, firm.orgId, { userId });
  const booked = await bookLesson(
    db,
    { organizationId: firm.orgId, userId },
    { clientId, instructorId: firm.instructorId, serviceId: firm.serviceId, startsAt: at('16:00'), payOnline: true, now: NOW },
  );
  return { clientId, bookingId: booked.bookingId, paymentId: booked.payment!.paymentId, holdExpiresAt: booked.payment!.holdExpiresAt };
}

describe('Wygasanie blokad terminu na płatność', () => {
  it('wygasła blokada terminu na płatność zwalnia termin, a płatność przepada', async () => {
    const firm = await createFirm();
    const held = await heldFirstLesson(firm);

    expect(await runFirmTasks(db, firm.orgId, new Date(held.holdExpiresAt.getTime() - MINUTE))).toMatchObject({ expiredHolds: 0 });
    expect(await bookingStatus(held.bookingId)).toBe('pending_payment');

    expect(await runFirmTasks(db, firm.orgId, held.holdExpiresAt)).toMatchObject({ expiredHolds: 1 });
    expect(await bookingStatus(held.bookingId)).toBe('expired');
    const { rows } = await owner.query('SELECT status FROM payments WHERE id = $1', [held.paymentId]);
    expect(rows).toEqual([{ status: 'expired' }]);

    // Termin jest znowu wolny: szkoła wpisuje w nim lekcję innej parze.
    const other = await createClient(owner, firm.orgId, { status: 'trusted', creditLimit: 1 });
    await expect(
      bookLesson(db, firm.staff, { clientId: other, instructorId: firm.instructorId, serviceId: firm.serviceId, startsAt: at('16:00'), now: NOW }),
    ).resolves.toMatchObject({ payment: null });
  });

  it('płatność, która dotrze po wygaśnięciu blokady w tle, trafia na konto jako lekcja do wykorzystania', async () => {
    const firm = await createFirm();
    const held = await heldFirstLesson(firm);
    await runFirmTasks(db, firm.orgId, held.holdExpiresAt);

    const outcome = await handleCheckoutEvent(
      db,
      {
        kind: 'completed',
        session: {
          id: `cs_test_${held.paymentId}`,
          url: null,
          status: 'complete',
          paymentStatus: 'paid',
          organizationId: firm.orgId,
          paymentId: held.paymentId,
          paymentIntentId: `pi_test_${held.paymentId}`,
        },
      },
      held.holdExpiresAt,
    );

    expect(outcome).toBe('late');
    expect(await bookingStatus(held.bookingId)).toBe('expired');
    const { rows } = await owner.query('SELECT balance FROM client_balances WHERE client_id = $1', [held.clientId]);
    expect(rows).toEqual([{ balance: 1 }]);
  });
});

describe('Lekcje odbyte', () => {
  it('lekcja po swoim końcu zmienia się na odbytą, a trwająca zostaje zarezerwowana', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId, { status: 'regular' });
    const id = await lesson(firm, clientId, '16:00');

    await runFirmTasks(db, firm.orgId, at('16:44'));
    expect(await bookingStatus(id)).toBe('confirmed');

    expect(await runFirmTasks(db, firm.orgId, at('16:45'))).toMatchObject({ completedLessons: 1 });
    expect(await bookingStatus(id)).toBe('completed');
  });

  it('odwołana lekcja i nieobecność nie zmieniają się na odbytą', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId, { status: 'regular' });
    const cancelled = await lesson(firm, clientId, '16:00', 'cancelled');
    const late = await lesson(firm, clientId, '17:00', 'late_cancelled');
    const noShow = await lesson(firm, clientId, '18:00', 'no_show');

    expect(await runFirmTasks(db, firm.orgId, at('21:00'))).toMatchObject({ completedLessons: 0 });
    expect([await bookingStatus(cancelled), await bookingStatus(late), await bookingStatus(noShow)]).toEqual([
      'cancelled',
      'late_cancelled',
      'no_show',
    ]);
  });

  it('bez automatycznego oznaczania w ustawieniach lekcja zostaje zarezerwowana, a para zostaje nowa', async () => {
    const firm = await createFirm({ autoComplete: false });
    const clientId = await createClient(owner, firm.orgId);
    await addCredits(owner, firm.orgId, clientId, 1, firm.ownerId);
    const id = await lesson(firm, clientId, '16:00');

    expect(await runFirmTasks(db, firm.orgId, at('21:00'))).toEqual({ expiredHolds: 0, completedLessons: 0, promotedClients: 0 });
    expect(await bookingStatus(id)).toBe('confirmed');
    expect((await clientRow(clientId))?.status).toBe('new');
  });

  it('nieobecność można oznaczyć także na lekcji oznaczonej w tle jako odbyta', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId, { status: 'regular' });
    const id = await lesson(firm, clientId, '16:00');
    await runFirmTasks(db, firm.orgId, at('17:00'));

    await markNoShow(db, firm.staff, { bookingId: id, now: at('17:05') });
    expect(await bookingStatus(id)).toBe('no_show');
  });
});

describe('Awans nowej pary', () => {
  it('nowa para po pierwszej odbytej lekcji staje się stała', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId);
    await addCredits(owner, firm.orgId, clientId, 1, firm.ownerId);
    await lesson(firm, clientId, '16:00');

    expect(await runFirmTasks(db, firm.orgId, at('17:00'))).toMatchObject({ completedLessons: 1, promotedClients: 1 });
    expect(await clientRow(clientId)).toEqual({ status: 'regular', credit_limit: 0 });
  });

  it('bez awansu w ustawieniach nowa para po odbytej lekcji zostaje nowa', async () => {
    const firm = await createFirm({ autoPromote: false });
    const clientId = await createClient(owner, firm.orgId);
    await addCredits(owner, firm.orgId, clientId, 1, firm.ownerId);
    const id = await lesson(firm, clientId, '16:00');

    expect(await runFirmTasks(db, firm.orgId, at('17:00'))).toMatchObject({ completedLessons: 1, promotedClients: 0 });
    expect(await bookingStatus(id)).toBe('completed');
    expect((await clientRow(clientId))?.status).toBe('new');
  });

  it('zaufana para po odbytej lekcji zostaje zaufana ze swoim limitem', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId, { status: 'trusted', creditLimit: 2 });
    await lesson(firm, clientId, '16:00');

    await runFirmTasks(db, firm.orgId, at('17:00'));
    expect(await clientRow(clientId)).toEqual({ status: 'trusted', credit_limit: 2 });
  });

  it('para, którą szkoła ustawiła z powrotem jako nową, zostaje nowa do kolejnej odbytej lekcji', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId);
    await lesson(firm, clientId, '16:00', 'completed'); // lekcja odbyta wcześniej
    await lesson(firm, clientId, '18:00');

    expect(await runFirmTasks(db, firm.orgId, at('17:00'))).toMatchObject({ promotedClients: 0 });
    expect((await clientRow(clientId))?.status).toBe('new');

    expect(await runFirmTasks(db, firm.orgId, at('19:00'))).toMatchObject({ promotedClients: 1 });
    expect((await clientRow(clientId))?.status).toBe('regular');
  });
});

describe('Przebiegi zadań w tle', () => {
  it('powtórzone zadania niczego nie dublują', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId);
    await lesson(firm, clientId, '16:00');

    await runFirmTasks(db, firm.orgId, at('17:00'));
    expect(await runFirmTasks(db, firm.orgId, at('17:01'))).toEqual({ expiredHolds: 0, completedLessons: 0, promotedClients: 0 });
    expect((await auditActions(firm.orgId)).map((r) => r.action)).toEqual(['booking.completed', 'client.promoted']);
  });

  it('dwa przebiegi zadań w tej samej chwili zmieniają każdą lekcję i parę raz', async () => {
    const firm = await createFirm();
    const clientId = await createClient(owner, firm.orgId);
    await lesson(firm, clientId, '16:00');

    const reports = await Promise.all([runFirmTasks(db, firm.orgId, at('17:00')), runFirmTasks(db, firm.orgId, at('17:00'))]);

    expect(reports.reduce((sum, r) => sum + r.completedLessons, 0)).toBe(1);
    expect(reports.reduce((sum, r) => sum + r.promotedClients, 0)).toBe(1);
    expect(await auditActions(firm.orgId)).toHaveLength(2);
  });

  it('zmiany w tle trafiają do dziennika bez autora', async () => {
    const firm = await createFirm();
    const held = await heldFirstLesson(firm); // 16:00, czeka na płatność
    const clientId = await createClient(owner, firm.orgId);
    const id = await lesson(firm, clientId, '17:00');

    await runFirmTasks(db, firm.orgId, at('18:00'));

    expect(await auditActions(firm.orgId)).toEqual([
      { action: 'booking.completed', entity_id: id, actor_user_id: null },
      { action: 'booking.hold_expired', entity_id: held.bookingId, actor_user_id: null },
      { action: 'client.promoted', entity_id: clientId, actor_user_id: null },
    ]);
  });

  it('zadania w tle działają w każdej firmie osobno, według jej ustawień', async () => {
    const on = await createFirm();
    const off = await createFirm({ autoComplete: false });
    const lessonOn = await lesson(on, await createClient(owner, on.orgId, { status: 'regular' }), '16:00');
    const lessonOff = await lesson(off, await createClient(owner, off.orgId, { status: 'regular' }), '16:00');
    const errors: unknown[] = [];

    const report = await runAllFirms(db, at('17:00'), { error: (...args: unknown[]) => errors.push(args) });

    expect(errors).toEqual([]);
    expect(report.completedLessons).toBeGreaterThanOrEqual(1);
    expect(await bookingStatus(lessonOn)).toBe('completed');
    expect(await bookingStatus(lessonOff)).toBe('confirmed');
  });

  it('log serwera opisuje zmiany po polsku i milczy, gdy nic się nie zmieniło', () => {
    expect(describeReport({ expiredHolds: 1, completedLessons: 3, promotedClients: 0 })).toBe('wygasłe blokady: 1, odbyte lekcje: 3');
    expect(describeReport({ expiredHolds: 0, completedLessons: 0, promotedClients: 0 })).toBeNull();
  });
});
