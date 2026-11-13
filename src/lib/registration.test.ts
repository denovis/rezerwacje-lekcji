// Samodzielna rejestracja nowej pary (zasady z docs/decyzje.md) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant().
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appTestDatabaseUrl,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  createWeeklyHours,
} from '../../db/tests/helpers.ts';
import { createAuth, type Auth } from './auth';
import { bookLesson, BookingError, type FirmContext } from './bookings';
import { addClient, ClientError } from './clients';
import { createDb, type Database } from './db';
import { listMyFirms } from './firms';
import { localToInstant, timeToMinutes } from './local-time';
import { findFirmBySlug, registerClient, signUpState } from './registration';

const TZ = 'Europe/Warsaw';
const at = (time: string, day = '2027-01-11') => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04');

let owner: pg.Pool;
let db: Database;
let auth: Auth;
const sent: { to: string; url: string }[] = [];

beforeAll(() => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
  auth = createAuth({
    db,
    baseURL: 'http://localhost:3000',
    secret: 'sekret-testowy-co-najmniej-32-znaki-dlugi',
    sendMagicLink: async (to, url) => {
      sent.push({ to, url });
    },
  });
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

interface Firm {
  orgId: string;
  slug: string;
  ownerId: string;
  instructorId: string;
  serviceId: string;
  staff: FirmContext;
}

/** Osobna szkoła na każdy test: właściciel, instruktorka (codziennie 16:00–21:00), lekcja 45 minut za 200 zł. */
async function createFirm(): Promise<Firm> {
  const orgId = await createOrg(owner);
  const { rows } = await owner.query<{ slug: string }>('SELECT slug FROM organizations WHERE id = $1', [orgId]);
  const ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  return { orgId, slug: rows[0]!.slug, ownerId, instructorId, serviceId, staff: { organizationId: orgId, userId: ownerId } };
}

/** Nowa osoba z kontem (zalogowana linkiem z maila) i jej kontekst w szkole. */
async function newPerson(firm: Firm): Promise<{ userId: string; email: string; ctx: FirmContext }> {
  const userId = await createUser(owner);
  const { rows } = await owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  return { userId, email: rows[0]!.email, ctx: { organizationId: firm.orgId, userId } };
}

const COUPLE = { displayName: ' Anna i Piotr ', phone: ' 600 100 200 ', targetDate: '2027-06-19' };

/** Kod odmowy (ClientError) albo opis innego wyniku. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ClientError ? err.code : `inny błąd: ${String(err)}`;
  }
  return 'brak odmowy';
}

async function clientsOf(orgId: string) {
  const { rows } = await owner.query<{
    id: string;
    user_id: string | null;
    display_name: string;
    email: string | null;
    phone: string | null;
    target_date: string | null;
    status: string;
    credit_limit: number;
  }>(
    `SELECT id, user_id, display_name, email, phone, to_char(target_date, 'YYYY-MM-DD') AS target_date, status, credit_limit
     FROM clients WHERE organization_id = $1`,
    [orgId],
  );
  return rows;
}

describe('Strona zapisów szkoły', () => {
  it('strona zapisów znajduje szkołę po adresie, także bez logowania', async () => {
    const firm = await createFirm();
    expect(await findFirmBySlug(db, firm.slug)).toEqual({ id: firm.orgId, slug: firm.slug, name: 'Szkoła' });
  });

  it('nieznany albo błędny adres szkoły nie prowadzi do żadnej szkoły', async () => {
    expect(await findFirmBySlug(db, 'nie-ma-takiej-szkoly')).toBeNull();
    expect(await findFirmBySlug(db, "Zły adres'; --")).toBeNull();
    expect(await findFirmBySlug(db, '')).toBeNull();
  });

  it('link z maila na stronie zapisów zakłada konto i prowadzi z powrotem na stronę zapisów', async () => {
    const firm = await createFirm();
    const email = `zapis-${Date.now()}@example.com`;
    const here = `/zapisy/${firm.slug}`;
    await auth.api.signInMagicLink({ body: { email, callbackURL: here, errorCallbackURL: here }, headers: new Headers() });
    const link = new URL(sent.at(-1)!.url);
    expect(sent.at(-1)!.to).toBe(email);

    const res = await auth.api.magicLinkVerify({
      query: Object.fromEntries(link.searchParams) as { token: string; callbackURL: string },
      headers: new Headers(),
      asResponse: true,
    });
    expect(res.headers.get('location')).toBe(`http://localhost:3000${here}`);
    const cookie = /better-auth\.session_token=[^;]+/.exec(res.headers.get('set-cookie') ?? '')![0];
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe(email);

    // Konto jest, ale profilu pary w szkole jeszcze nie ma: para dopiero poda dane.
    const ctx = { organizationId: firm.orgId, userId: session!.user.id };
    expect(await signUpState(db, ctx)).toBe('open');
    expect(await clientsOf(firm.orgId)).toEqual([]);
  });
});

describe('Samodzielna rejestracja nowej pary', () => {
  it('nowa para zapisuje się sama: status nowy, limit 0 i adres, którym się zalogowała', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);

    const { id, created } = await registerClient(db, person.ctx, COUPLE);

    expect(created).toBe(true);
    expect(await clientsOf(firm.orgId)).toEqual([
      {
        id,
        user_id: person.userId,
        display_name: 'Anna i Piotr',
        email: person.email,
        phone: '600 100 200',
        target_date: '2027-06-19',
        status: 'new',
        credit_limit: 0,
      },
    ]);
  });

  it('po zapisie para widzi szkołę jako klient i trafia prosto do kalendarza', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);
    expect(await listMyFirms(db, person.userId)).toEqual([]);

    await registerClient(db, person.ctx, COUPLE);

    expect(await listMyFirms(db, person.userId)).toEqual([
      { id: firm.orgId, slug: firm.slug, name: 'Szkoła', roles: ['client'] },
    ]);
    expect(await signUpState(db, person.ctx)).toBe('client');
  });

  it('zapis wymaga nazwy pary i telefonu, a data ślubu jest opcjonalna', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);

    expect(await refusal(registerClient(db, person.ctx, { ...COUPLE, displayName: '  ' }))).toBe('name_required');
    expect(await refusal(registerClient(db, person.ctx, { ...COUPLE, phone: '' }))).toBe('phone_required');
    expect(await refusal(registerClient(db, person.ctx, { ...COUPLE, targetDate: '2027-02-30' }))).toBe('invalid_date');
    expect(await clientsOf(firm.orgId)).toEqual([]);

    await registerClient(db, person.ctx, { ...COUPLE, targetDate: '' });
    expect((await clientsOf(firm.orgId))[0]?.target_date).toBeNull();
  });

  it('para, która ma już profil w szkole, nie zakłada drugiego', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);

    const first = await registerClient(db, person.ctx, COUPLE);
    const again = await registerClient(db, person.ctx, { ...COUPLE, displayName: 'Inna nazwa' });

    expect(again).toEqual({ id: first.id, created: false });
    const rows = await clientsOf(firm.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.display_name).toBe('Anna i Piotr');
  });

  it('dwa zapisy tej samej pary w tej samej chwili zakładają jeden profil', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);

    const results = await Promise.all([registerClient(db, person.ctx, COUPLE), registerClient(db, person.ctx, COUPLE)]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await clientsOf(firm.orgId)).toHaveLength(1);
  });

  it('para dodana wcześniej przez szkołę po zalogowaniu trafia do swojego profilu, bez zakładania drugiego', async () => {
    const firm = await createFirm();
    const email = `dodana-${Date.now()}@example.com`;
    const { id } = await addClient(db, firm.staff, { displayName: 'Ewa i Jan', email });
    const { rows } = await owner.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const ctx = { organizationId: firm.orgId, userId: rows[0]!.id };

    expect(await signUpState(db, ctx)).toBe('client');
    expect(await registerClient(db, ctx, COUPLE)).toEqual({ id, created: false });
    expect(await clientsOf(firm.orgId)).toHaveLength(1);
  });

  it('osoba z rolą w szkole nie zapisuje się jako para', async () => {
    const firm = await createFirm();
    const instructor = await newPerson(firm);
    await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'instructor')", [
      firm.orgId,
      instructor.userId,
    ]);

    expect(await signUpState(db, firm.staff)).toBe('member');
    expect(await refusal(registerClient(db, firm.staff, COUPLE))).toBe('signup_member');
    expect(await signUpState(db, instructor.ctx)).toBe('member');
    expect(await refusal(registerClient(db, instructor.ctx, COUPLE))).toBe('signup_member');
    expect(await clientsOf(firm.orgId)).toEqual([]);
  });

  it('adres zajęty przez inną parę w szkole blokuje zapis', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);
    // Para bez konta, wpisana z tym samym adresem (np. ze starych danych szkoły).
    await owner.query("INSERT INTO clients (organization_id, display_name, email) VALUES ($1, 'Stara para', upper($2))", [
      firm.orgId,
      person.email,
    ]);

    expect(await refusal(registerClient(db, person.ctx, COUPLE))).toBe('signup_email_taken');
    expect(await clientsOf(firm.orgId)).toHaveLength(1);
  });

  it('zapis w jednej szkole nie daje dostępu do innej', async () => {
    const firm = await createFirm();
    const other = await createFirm();
    const person = await newPerson(firm);

    await registerClient(db, person.ctx, COUPLE);

    expect((await listMyFirms(db, person.userId)).map((f) => f.id)).toEqual([firm.orgId]);
    expect(await signUpState(db, { organizationId: other.orgId, userId: person.userId })).toBe('open');
  });

  it('zapis trafia do dziennika szkoły', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);

    const { id } = await registerClient(db, person.ctx, COUPLE);

    const { rows } = await owner.query<{ actor_user_id: string; action: string; data: Record<string, unknown> }>(
      "SELECT actor_user_id, action, data FROM audit_log WHERE organization_id = $1 AND entity_id = $2",
      [firm.orgId, id],
    );
    expect(rows).toEqual([
      {
        actor_user_id: person.userId,
        action: 'client.registered',
        data: { displayName: 'Anna i Piotr', email: person.email, phone: '600 100 200', targetDate: '2027-06-19' },
      },
    ]);
  });

  it('nowa para po zapisie rezerwuje pierwszą lekcję tylko z płatnością online', async () => {
    const firm = await createFirm();
    const person = await newPerson(firm);
    const { id: clientId } = await registerClient(db, person.ctx, COUPLE);
    const lesson = { clientId, instructorId: firm.instructorId, serviceId: firm.serviceId, startsAt: at('16:00'), now: NOW };

    const refused = await bookLesson(db, person.ctx, lesson).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BookingError);
    expect((refused as BookingError).code).toBe('payment_required');

    const booked = await bookLesson(db, person.ctx, { ...lesson, payOnline: true });
    expect(booked.payment).toMatchObject({ amountCents: 20000 });
    const { rows } = await owner.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [booked.bookingId]);
    expect(rows[0]?.status).toBe('pending_payment');
  });
});
