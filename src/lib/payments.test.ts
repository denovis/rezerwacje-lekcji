// Pakiety i gotówka w panelu szkoły (zasady z docs/decyzje.md) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant().
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appTestDatabaseUrl,
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  createWeeklyHours,
} from '../../db/tests/helpers.ts';
import { bookLesson, type FirmContext } from './bookings';
import { clientHistory, loadClients } from './clients';
import { createDb, type Database } from './db';
import { localToInstant, timeToMinutes } from './local-time';
import { addPackage, PaymentError, recordCashPayment, updatePackage } from './payments';
import { loadScheduleSetup, updateService } from './schedule-setup';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11';
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04');

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

/** Osobna szkoła na każdy test: właściciel, instruktorka (codziennie 16:00–21:00), lekcja 45 minut, nowa para bez lekcji. */
async function createFirm(): Promise<Firm> {
  const orgId = await createOrg(owner);
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  const clientUser = await createUser(owner);
  const clientId = await createClient(owner, orgId, { userId: clientUser, status: 'new' });
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

/** Kod odmowy (PaymentError) albo opis innego wyniku. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof PaymentError ? err.code : `inny błąd: ${String(err)}`;
  }
  return 'brak odmowy';
}

describe('Gotówka w panelu', () => {
  it('gotówka dopisuje lekcje na konto i zapisuje, kto przyjął, ile zł i ile lekcji', async () => {
    const firm = await createFirm();
    const result = await recordCashPayment(db, firm.staff, {
      clientId: firm.clientId,
      credits: 2,
      amountCents: 36000,
      note: 'Dwie lekcje',
      now: NOW,
    });
    expect(result).toMatchObject({ credits: 2, amountCents: 36000, balance: 2 });

    const { rows } = await owner.query(
      'SELECT method, status, amount_cents, credits, created_by, paid_at, package_id FROM payments WHERE id = $1',
      [result.paymentId],
    );
    expect(rows).toEqual([
      { method: 'cash', status: 'paid', amount_cents: 36000, credits: 2, created_by: firm.ownerId, paid_at: NOW, package_id: null },
    ]);
    const entries = await owner.query('SELECT delta, reason, payment_id FROM credit_entries WHERE client_id = $1', [firm.clientId]);
    expect(entries.rows).toEqual([{ delta: 2, reason: 'purchase', payment_id: result.paymentId }]);
  });

  it('wpłata gotówką za pakiet dopisuje lekcje z pakietu, a kwotę bierze z ceny pakietu, jeśli szkoła jej nie zmieni', async () => {
    const firm = await createFirm();
    const { id: packageId } = await addPackage(db, firm.staff, { name: 'Pakiet 5 lekcji', credits: 5, priceCents: 90000 });
    const full = await recordCashPayment(db, firm.staff, { clientId: firm.clientId, packageId, now: NOW });
    expect(full).toMatchObject({ credits: 5, amountCents: 90000, balance: 5 });
    const discounted = await recordCashPayment(db, firm.staff, { clientId: firm.clientId, packageId, amountCents: 80000, now: NOW });
    expect(discounted).toMatchObject({ credits: 5, amountCents: 80000, balance: 10 });
  });

  it('nowa para po wpłacie gotówką rezerwuje lekcję bez płatności online', async () => {
    const firm = await createFirm();
    await recordCashPayment(db, firm.staff, { clientId: firm.clientId, credits: 1, amountCents: 18000, now: NOW });
    const lesson = await bookLesson(db, firm.client, {
      clientId: firm.clientId,
      instructorId: firm.instructorId,
      serviceId: firm.serviceId,
      startsAt: at('16:00'),
      now: NOW,
    });
    expect(lesson.bookingId).toBeTruthy();
  });

  it('historia pary pokazuje wpłatę gotówką z pakietem, kwotą i osobą, która przyjęła', async () => {
    const firm = await createFirm();
    const { id: packageId } = await addPackage(db, firm.staff, { name: 'Pakiet 5 lekcji', credits: 5, priceCents: 90000 });
    await recordCashPayment(db, firm.staff, { clientId: firm.clientId, packageId, note: 'Zapłacili przy pierwszej lekcji', now: NOW });

    const history = await clientHistory(db, firm.staff, { clientId: firm.clientId });
    const { rows } = await owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [firm.ownerId]);
    expect(history.entries.map((e) => [e.reasonLabel, e.delta, e.details?.replace(/\s/g, ' '), e.author])).toEqual([
      ['Płatność', 5, 'gotówka, Pakiet 5 lekcji, 900,00 zł, Zapłacili przy pierwszej lekcji', rows[0]!.email],
    ]);
  });

  it('wpłata gotówką ma od 1 do 100 lekcji i kwotę od 0 do 100 000 zł', async () => {
    const firm = await createFirm();
    const pay = (credits: number, amountCents: number) =>
      recordCashPayment(db, firm.staff, { clientId: firm.clientId, credits, amountCents, now: NOW });
    expect(await refusal(pay(0, 1000))).toBe('invalid_credits');
    expect(await refusal(pay(101, 1000))).toBe('invalid_credits');
    expect(await refusal(pay(1, -1))).toBe('invalid_amount');
    expect(await refusal(pay(1, 10_000_001))).toBe('invalid_amount');
    expect(await refusal(pay(1, 99.5))).toBe('invalid_amount');
    expect((await pay(1, 0)).balance).toBe(1); // lekcja gratis też jest wpłatą (0 zł)
  });

  it('wyłączonego pakietu nie można sprzedać, a wcześniejsza sprzedaż zostaje', async () => {
    const firm = await createFirm();
    const { id: packageId } = await addPackage(db, firm.staff, { name: 'Pakiet 5 lekcji', credits: 5, priceCents: 90000 });
    await recordCashPayment(db, firm.staff, { clientId: firm.clientId, packageId, now: NOW });
    await updatePackage(db, firm.staff, { packageId, name: 'Pakiet 5 lekcji', credits: 5, priceCents: 90000, active: false });

    expect(await refusal(recordCashPayment(db, firm.staff, { clientId: firm.clientId, packageId, now: NOW }))).toBe('package_not_found');
    expect((await clientHistory(db, firm.staff, { clientId: firm.clientId })).balance).toBe(5);
    expect((await loadClients(db, firm.staff, NOW)).packages).toEqual([]);
  });
});

describe('Pakiety i ceny w ustawieniach', () => {
  it('szkoła dodaje, zmienia i wyłącza pakiet; ustawienia pokazują najpierw aktywne', async () => {
    const firm = await createFirm();
    const { id: five } = await addPackage(db, firm.staff, { name: ' Pakiet 5 lekcji ', credits: 5, priceCents: 90000 });
    const { id: ten } = await addPackage(db, firm.staff, { name: 'Pakiet 10 lekcji', credits: 10, priceCents: 170000 });
    await updatePackage(db, firm.staff, { packageId: five, name: 'Pakiet 5 lekcji', credits: 5, priceCents: 85000, active: false });

    const setup = await loadScheduleSetup(db, firm.staff, NOW);
    expect(setup.packages).toEqual([
      { id: ten, name: 'Pakiet 10 lekcji', credits: 10, priceCents: 170000, active: true },
      { id: five, name: 'Pakiet 5 lekcji', credits: 5, priceCents: 85000, active: false },
    ]);
    expect(setup.currency).toBe('PLN');
  });

  it('pakiet ma od 1 do 100 lekcji i cenę od 0 do 100 000 zł', async () => {
    const firm = await createFirm();
    const add = (credits: number, priceCents: number, name = 'Pakiet') => addPackage(db, firm.staff, { name, credits, priceCents });
    expect(await refusal(add(0, 1000))).toBe('invalid_package_credits');
    expect(await refusal(add(101, 1000))).toBe('invalid_package_credits');
    expect(await refusal(add(5, -100))).toBe('invalid_package_price');
    expect(await refusal(add(5, 10_000_001))).toBe('invalid_package_price');
    expect(await refusal(add(5, 1000, '  '))).toBe('name_required');
  });

  it('cena lekcji w usłudze trafia do formularza wpłaty; zmiana bez ceny jej nie kasuje', async () => {
    const firm = await createFirm();
    const fields = { serviceId: firm.serviceId, name: 'Lekcja pierwszego tańca', durationMinutes: 45, creditCost: 1, active: true };
    await updateService(db, firm.staff, { ...fields, priceCents: 18000 });
    expect((await loadClients(db, firm.staff, NOW)).lessonPriceCents).toBe(18000);
    await updateService(db, firm.staff, { ...fields, durationMinutes: 60 });
    expect((await loadClients(db, firm.staff, NOW)).lessonPriceCents).toBe(18000);
    await updateService(db, firm.staff, { ...fields, priceCents: null });
    expect((await loadClients(db, firm.staff, NOW)).lessonPriceCents).toBeNull();
  });
});

describe('Kto przyjmuje płatności', () => {
  it('gotówkę przyjmuje i pakiety prowadzi tylko szkoła: para i instruktor dostają odmowę', async () => {
    const firm = await createFirm();
    const instructorUser = await createUser(owner);
    await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'instructor')", [firm.orgId, instructorUser]);
    for (const ctx of [firm.client, { organizationId: firm.orgId, userId: instructorUser }]) {
      expect(await refusal(recordCashPayment(db, ctx, { clientId: firm.clientId, credits: 5, amountCents: 0, now: NOW }))).toBe(
        'not_allowed',
      );
      expect(await refusal(addPackage(db, ctx, { name: 'Pakiet', credits: 5, priceCents: 0 }))).toBe('not_allowed');
    }
    expect((await clientHistory(db, firm.staff, { clientId: firm.clientId })).balance).toBe(0);
  });

  it('szkoła nie przyjmie gotówki dla klienta innej firmy ani nie sprzeda pakietu innej firmy', async () => {
    const firm = await createFirm();
    const other = await createFirm();
    const { id: otherPackage } = await addPackage(db, other.staff, { name: 'Obcy pakiet', credits: 5, priceCents: 90000 });

    expect(await refusal(recordCashPayment(db, firm.staff, { clientId: other.clientId, credits: 1, amountCents: 0, now: NOW }))).toBe(
      'client_not_found',
    );
    expect(await refusal(recordCashPayment(db, firm.staff, { clientId: firm.clientId, packageId: otherPackage, now: NOW }))).toBe(
      'package_not_found',
    );
    expect(
      await refusal(updatePackage(db, firm.staff, { packageId: otherPackage, name: 'Przejęty', credits: 1, priceCents: 0, active: true })),
    ).toBe('package_not_found');
  });
});
