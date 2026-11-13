// Maile z zadań w tle (zasady z docs/decyzje.md, „Maile z zadań w tle”) na prawdziwej bazie,
// widzianej tak jak przez aplikację: rola app_user i withTenant(). Zamiast serwera SMTP zbieramy maile w tablicy.
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
  insertBooking,
} from '../../db/tests/helpers.ts';
import { runAllFirms } from './background';
import { createDb, type Database } from './db';
import type { Email } from './email';
import { formatMoney } from './format';
import { localToInstant, timeToMinutes } from './local-time';
import { MAX_ATTEMPTS, sendFirmEmails, type MailDeps } from './notifications';
import { registerClient } from './registration';

const TZ = 'Europe/Warsaw';
const MONDAY = '2027-01-11'; // czas zimowy (UTC+1)
const at = (time: string, day = MONDAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const SUNDAY = '2027-01-10';
const BASE_URL = 'http://localhost:3000';

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

/** Skrzynka testowa: zbiera wysłane maile; fail = ile pierwszych wysyłek ma się nie udać. */
function mailbox(fail = 0): MailDeps & { sent: Email[]; calls: number } {
  const box = {
    sent: [] as Email[],
    calls: 0,
    baseUrl: BASE_URL,
    sendEmail: async (email: Email) => {
      box.calls++;
      if (box.calls <= fail) throw new Error('SMTP nie odpowiada');
      box.sent.push(email);
    },
  };
  return box;
}

interface Firm {
  orgId: string;
  slug: string;
  ownerEmail: string;
  adminEmail: string;
  instructorUserEmail: string;
  instructorId: string;
  serviceId: string;
}

async function emailOf(userId: string): Promise<string> {
  const { rows } = await owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  return rows[0]!.email;
}

/** Szkoła z właścicielem, administratorem i instruktorką z kontem; lekcja 45 minut za 200 zł. */
async function createFirm(reminderHours = 24): Promise<Firm> {
  const orgId = await createOrg(owner);
  await owner.query('UPDATE organization_settings SET reminder_hours_before = $2 WHERE organization_id = $1', [orgId, reminderHours]);
  const { rows } = await owner.query<{ slug: string }>('SELECT slug FROM organizations WHERE id = $1', [orgId]);
  const roles: Record<string, string> = {};
  for (const role of ['owner', 'admin', 'instructor']) {
    const userId = await createUser(owner);
    await owner.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgId, userId, role]);
    roles[role] = await emailOf(userId);
  }
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  await createWeeklyHours(owner, orgId, instructorId);
  const serviceId = await createService(owner, orgId, 45);
  return {
    orgId,
    slug: rows[0]!.slug,
    ownerEmail: roles.owner!,
    adminEmail: roles.admin!,
    instructorUserEmail: roles.instructor!,
    instructorId,
    serviceId,
  };
}

const uniqueEmail = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/** Para z adresem e-mail (bez konta) albo bez adresu. */
async function couple(firm: Firm, email: string | null = uniqueEmail('para')): Promise<{ id: string; email: string | null }> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO clients (organization_id, display_name, email, status) VALUES ($1, 'Anna i Piotr', $2, 'regular') RETURNING id",
    [firm.orgId, email],
  );
  return { id: rows[0]!.id, email };
}

/** Lekcja 45 minut w poniedziałek o podanej godzinie, zarezerwowana dawno temu (created_at = teraz, czyli przed 2027 r.). */
async function lesson(firm: Firm, clientId: string, time = '16:00', status = 'confirmed'): Promise<string> {
  const start = at(time);
  const { rows } = await insertBooking(owner, {
    orgId: firm.orgId,
    instructorId: firm.instructorId,
    clientId,
    serviceId: firm.serviceId,
    start: start.toISOString(),
    end: new Date(start.getTime() + 45 * 60_000).toISOString(),
    status,
  });
  return rows[0]!.id;
}

async function notificationRows(orgId: string) {
  const { rows } = await owner.query<{ kind: string; recipient: string; status: string; attempts: number; last_error: string | null }>(
    'SELECT kind, recipient, status, attempts, last_error FROM email_notifications WHERE organization_id = $1 ORDER BY recipient',
    [orgId],
  );
  return rows;
}

describe('Przypomnienie mailem przed lekcją', () => {
  it('para dostaje przypomnienie mailem w czasie z ustawień (domyślnie 24 godziny przed lekcją)', async () => {
    const firm = await createFirm();
    const { id, email } = await couple(firm);
    await lesson(firm, id);
    const box = mailbox();

    expect(await sendFirmEmails(db, firm.orgId, box, at('15:59', SUNDAY))).toEqual({ emailsSent: 0, emailsFailed: 0 });
    expect(await sendFirmEmails(db, firm.orgId, box, at('16:00', SUNDAY))).toEqual({ emailsSent: 1, emailsFailed: 0 });

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({ to: email, subject: 'Przypomnienie o lekcji: poniedziałek, 11 stycznia, 16:00' });
    expect(box.sent[0]!.text).toContain('Lekcja pierwszego tańca, poniedziałek, 11 stycznia, 16:00–16:45');
    expect(box.sent[0]!.text).toContain('Instruktor: Ola');
    expect(box.sent[0]!.text).toContain(`Kalendarz i Wasze lekcje: ${BASE_URL}/panel/${firm.slug}`);
    expect(await notificationRows(firm.orgId)).toEqual([
      { kind: 'lesson_reminder', recipient: email, status: 'sent', attempts: 1, last_error: null },
    ]);
  });

  it('przypomnienie podaje, do kiedy odwołanie zwraca lekcję, albo że ten czas minął', async () => {
    const early = await createFirm(48);
    await lesson(early, (await couple(early)).id);
    const earlyBox = mailbox();
    await sendFirmEmails(db, early.orgId, earlyBox, at('16:00', '2027-01-09'));
    expect(earlyBox.sent[0]!.text).toContain(
      'Jeśli nie możecie przyjść, odwołajcie lekcję w kalendarzu do 10 stycznia, 16:00. Wtedy lekcja wróci na Wasze konto.',
    );

    const late = await createFirm(24);
    await lesson(late, (await couple(late)).id);
    const lateBox = mailbox();
    await sendFirmEmails(db, late.orgId, lateBox, at('16:30', SUNDAY));
    expect(lateBox.sent[0]!.text).toContain('Termin odwołania ze zwrotem lekcji już minął.');
  });

  it('przypomnienie przychodzi raz', async () => {
    const firm = await createFirm();
    await lesson(firm, (await couple(firm)).id);
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box, at('16:00', SUNDAY));
    await sendFirmEmails(db, firm.orgId, box, at('16:01', SUNDAY));
    await sendFirmEmails(db, firm.orgId, box, at('15:00'));

    expect(box.sent).toHaveLength(1);
  });

  it('po przerwie w działaniu aplikacji przypomnienie wychodzi, o ile lekcja jeszcze się nie zaczęła', async () => {
    const firm = await createFirm();
    await lesson(firm, (await couple(firm)).id, '16:00');
    await lesson(firm, (await couple(firm)).id, '17:00');
    const box = mailbox();

    // Aplikacja ruszyła w poniedziałek o 16:30: lekcja 16:00 trwa, lekcja 17:00 jeszcze nie.
    await sendFirmEmails(db, firm.orgId, box, at('16:30'));

    expect(box.sent.map((m) => m.subject)).toEqual(['Przypomnienie o lekcji: poniedziałek, 11 stycznia, 17:00']);
  });

  it('bez przypomnień, gdy w ustawieniach jest 0 godzin', async () => {
    const firm = await createFirm(0);
    await lesson(firm, (await couple(firm)).id);
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box, at('15:00'));
    expect(box.sent).toEqual([]);
  });

  it('para, która zarezerwowała lekcję już po czasie przypomnienia, nie dostaje go', async () => {
    const firm = await createFirm();
    const id = await lesson(firm, (await couple(firm)).id);
    await owner.query('UPDATE bookings SET created_at = $2 WHERE id = $1', [id, at('18:00', SUNDAY)]);
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box, at('18:00', SUNDAY));
    expect(box.sent).toEqual([]);
  });

  it('odwołana lekcja i lekcja czekająca na płatność nie dostają przypomnienia', async () => {
    const firm = await createFirm();
    await lesson(firm, (await couple(firm)).id, '16:00', 'cancelled');
    await lesson(firm, (await couple(firm)).id, '17:00', 'pending_payment');
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box, at('16:30', SUNDAY));
    expect(box.sent).toEqual([]);
  });

  it('para bez adresu e-mail nie dostaje przypomnienia, a para z kontem bez adresu w profilu dostaje je na adres konta', async () => {
    const firm = await createFirm();
    await lesson(firm, (await couple(firm, null)).id, '16:00');
    const userId = await createUser(owner);
    const { rows } = await owner.query<{ id: string }>(
      "INSERT INTO clients (organization_id, user_id, display_name, status) VALUES ($1, $2, 'Ewa i Jan', 'regular') RETURNING id",
      [firm.orgId, userId],
    );
    await lesson(firm, rows[0]!.id, '17:00');
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box, at('17:00', SUNDAY));
    expect(box.sent.map((m) => m.to)).toEqual([await emailOf(userId)]);
  });
});

describe('Nieudana wysyłka', () => {
  it(`nieudana wysyłka zostaje zapisana z błędem i jest ponawiana, razem najwyżej ${MAX_ATTEMPTS} razy`, async () => {
    const firm = await createFirm();
    const { id, email } = await couple(firm);
    await lesson(firm, id);
    const box = mailbox(100);

    expect(await sendFirmEmails(db, firm.orgId, box, at('16:00', SUNDAY))).toEqual({ emailsSent: 0, emailsFailed: 1 });
    expect(await notificationRows(firm.orgId)).toEqual([
      { kind: 'lesson_reminder', recipient: email, status: 'failed', attempts: 1, last_error: 'SMTP nie odpowiada' },
    ]);
    for (let minute = 1; minute <= 10; minute++) await sendFirmEmails(db, firm.orgId, box, at(`16:${String(minute).padStart(2, '0')}`, SUNDAY));

    expect(box.calls).toBe(MAX_ATTEMPTS);
    expect((await notificationRows(firm.orgId))[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
  });

  it('po nieudanej próbie kolejna udana wysyłka kończy sprawę', async () => {
    const firm = await createFirm();
    await lesson(firm, (await couple(firm)).id);
    const box = mailbox(1);

    await sendFirmEmails(db, firm.orgId, box, at('16:00', SUNDAY));
    await sendFirmEmails(db, firm.orgId, box, at('16:01', SUNDAY));
    await sendFirmEmails(db, firm.orgId, box, at('16:02', SUNDAY));

    expect(box.sent).toHaveLength(1);
    expect((await notificationRows(firm.orgId))[0]).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
  });

  it('dwa przebiegi w tej samej chwili wysyłają każdy mail raz', async () => {
    const firm = await createFirm();
    await lesson(firm, (await couple(firm)).id);
    const box = mailbox();

    const reports = await Promise.all([
      sendFirmEmails(db, firm.orgId, box, at('16:00', SUNDAY)),
      sendFirmEmails(db, firm.orgId, box, at('16:00', SUNDAY)),
    ]);

    expect(reports.reduce((sum, r) => sum + r.emailsSent, 0)).toBe(1);
    expect(box.sent).toHaveLength(1);
  });
});

describe('Alerty dla szkoły', () => {
  it('szkoła dostaje maila o nowej parze, która zapisała się sama', async () => {
    const firm = await createFirm();
    const userId = await createUser(owner);
    const email = await emailOf(userId);
    const { id } = await registerClient(
      db,
      { organizationId: firm.orgId, userId },
      { displayName: 'Marta i Tomek', phone: '600 700 800', targetDate: '2027-06-19' },
    );
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box);

    // Właściciel i administrator, bez instruktora.
    expect(box.sent.map((m) => m.to).sort()).toEqual([firm.adminEmail, firm.ownerEmail].sort());
    const mail = box.sent[0]!;
    expect(mail.subject).toBe('Nowa para zapisała się: Marta i Tomek');
    expect(mail.text).toContain(`E-mail: ${email}`);
    expect(mail.text).toContain('Telefon: 600 700 800');
    expect(mail.text).toContain('Data ślubu: 19 czerwca 2027');
    expect(mail.text).toContain(`${BASE_URL}/panel/${firm.slug}/klienci?para=${id}`);

    await sendFirmEmails(db, firm.orgId, box);
    expect(box.sent).toHaveLength(2);
  });

  it('szkoła dostaje maila o płatności, która dotarła po zwolnieniu terminu', async () => {
    const firm = await createFirm();
    const { id: clientId } = await couple(firm);
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO payments (organization_id, client_id, method, status, amount_cents, credits, paid_at)
       VALUES ($1, $2, 'stripe', 'paid', 20000, 1, now()) RETURNING id`,
      [firm.orgId, clientId],
    );
    const paymentId = rows[0]!.id;
    const bookingId = await lesson(firm, clientId, '16:00', 'expired');
    await owner.query('UPDATE bookings SET payment_id = $2 WHERE id = $1', [bookingId, paymentId]);
    await owner.query(
      "INSERT INTO audit_log (organization_id, action, entity, entity_id, data) VALUES ($1, 'payment.late', 'payments', $2, '{}')",
      [firm.orgId, paymentId],
    );
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box);

    expect(box.sent.map((m) => m.to).sort()).toEqual([firm.adminEmail, firm.ownerEmail].sort());
    expect(box.sent[0]!.subject).toBe('Płatność po czasie: Anna i Piotr');
    expect(box.sent[0]!.text).toContain(
      `para Anna i Piotr zapłaciła online ${formatMoney(20000)} za lekcję 11 stycznia, 16:00, ale płatność dotarła po czasie i termin wrócił już do puli.`,
    );
    expect(box.sent[0]!.text).toContain(`${BASE_URL}/panel/${firm.slug}/klienci?para=${clientId}`);
  });

  it('alerty dla szkoły tylko o zdarzeniach z ostatnich 7 dni', async () => {
    const firm = await createFirm();
    const { id } = await registerClient(
      db,
      { organizationId: firm.orgId, userId: await createUser(owner) },
      { displayName: 'Stara para', phone: '600 000 000' },
    );
    await owner.query("UPDATE audit_log SET created_at = now() - interval '8 days' WHERE entity_id = $1", [id]);
    const box = mailbox();

    await sendFirmEmails(db, firm.orgId, box);
    expect(box.sent).toEqual([]);
  });

  it('maile jednej szkoły nie trafiają do innej', async () => {
    const a = await createFirm();
    const b = await createFirm();
    await registerClient(db, { organizationId: a.orgId, userId: await createUser(owner) }, { displayName: 'Para A', phone: '600 1' });
    const boxA = mailbox();
    const boxB = mailbox();

    await sendFirmEmails(db, b.orgId, boxB);
    await sendFirmEmails(db, a.orgId, boxA);

    expect(boxB.sent).toEqual([]);
    expect(boxA.sent.map((m) => m.to).sort()).toEqual([a.adminEmail, a.ownerEmail].sort());
    expect(await notificationRows(b.orgId)).toEqual([]);
  });
});

describe('Maile w zadaniach w tle', () => {
  it('zadania w tle wysyłają maile po zmianach statusów i liczą je w raporcie', async () => {
    const firm = await createFirm();
    const { id, email } = await couple(firm);
    await lesson(firm, id);
    const box = mailbox();
    const errors: unknown[] = [];

    const report = await runAllFirms(db, at('16:00', SUNDAY), { error: (...args: unknown[]) => errors.push(args) }, box);

    expect(errors).toEqual([]);
    expect(box.sent.some((m) => m.to === email)).toBe(true);
    expect(report.emailsSent).toBeGreaterThanOrEqual(1);
  });
});
