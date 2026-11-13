// Maile z zadań w tle (etap 5b): przypomnienie parze przed lekcją i alerty dla szkoły.
//
// Zasady (docs/decyzje.md, „Maile z zadań w tle”):
//  * Przypomnienie: reminder_hours_before przed zarezerwowaną lekcją (0 = bez przypomnień). Para dostaje je,
//    jeśli ma adres e-mail i zarezerwowała lekcję przed chwilą przypomnienia (świeżo zarezerwowanej nie przypominamy).
//    Gdy aplikacja nie działała, przypomnienie wychodzi po starcie, o ile lekcja jeszcze się nie zaczęła.
//  * Alerty dla szkoły, do właścicieli i administratorów: płatność, która dotarła po zwolnieniu terminu
//    (payment.late w dzienniku) i nowa para, która zapisała się sama (client.registered).
//    Tylko o zdarzeniach z ostatnich 7 dni, żeby po długiej przerwie nie zasypać szkoły starymi alertami.
//  * Każdy mail najwyżej raz na adresata: wiersz w email_notifications powstaje przed wysyłką, a unikalny klucz
//    nie wpuści drugiego (także z drugiego procesu). Nieudana wysyłka zostaje jako 'failed' z błędem; kolejne
//    przebiegi próbują ponownie, razem najwyżej MAX_ATTEMPTS razy, o ile mail jest jeszcze aktualny
//    (np. lekcja się nie zaczęła i nie została odwołana).
import { cancelDeadline } from './bookings';
import { withTenant, type Database } from './db';
import type { EmailKind } from './db-types';
import {
  clientRegisteredEmail,
  latePaymentEmail,
  lessonReminderEmail,
  type Email,
  type SendEmail,
} from './email';
import { formatDate, formatDay, formatMoney, formatTime } from './format';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Ile razy najwyżej próbujemy wysłać ten sam mail. */
export const MAX_ATTEMPTS = 5;
/** Alerty dla szkoły tylko o zdarzeniach z tylu ostatnich dni. */
export const ALERT_WINDOW_DAYS = 7;

export interface MailDeps {
  sendEmail: SendEmail;
  /** Adres aplikacji do linków w mailach, np. http://localhost:3000. */
  baseUrl: string;
}

export interface MailReport {
  emailsSent: number;
  emailsFailed: number;
}

interface Outgoing {
  kind: EmailKind;
  entityId: string;
  recipient: string;
  email: Email;
}

const link = (baseUrl: string, path: string) => new URL(path, baseUrl).toString();
const lower = (value: string) => value.toLowerCase();

/** Data ślubu z bazy (RRRR-MM-DD) po polsku, np. „19 czerwca 2027”. */
function weddingDate(date: string | null): string | null {
  return date ? `${formatDate(new Date(`${date}T12:00:00Z`), 'UTC')} ${date.slice(0, 4)}` : null;
}

/**
 * Wybiera maile do wysłania w jednej firmie i rezerwuje je w email_notifications (status 'sending').
 * Zwraca tylko maile zarezerwowane przez to wywołanie: nowe i ponawiane po nieudanej wysyłce.
 */
function claimFirmEmails(db: Database, organizationId: string, baseUrl: string, now: Date): Promise<(Outgoing & { id: string })[]> {
  return withTenant(db, { organizationId, userId: null }, async (tx) => {
    const firm = await tx
      .selectFrom('organizations as o')
      .innerJoin('organizationSettings as s', 's.organizationId', 'o.id')
      .select(['o.name', 'o.slug', 'o.timezone', 'o.currency', 's.reminderHoursBefore', 's.cancelDeadlineHours'])
      .where('o.id', '=', organizationId)
      .executeTakeFirst();
    if (!firm) return [];
    const tz = firm.timezone;
    const outgoing: Outgoing[] = [];

    // 1. Przypomnienia o lekcjach.
    if (firm.reminderHoursBefore > 0) {
      const lead = firm.reminderHoursBefore * HOUR;
      const lessons = await tx
        .selectFrom('bookings as b')
        .innerJoin('clients as c', 'c.id', 'b.clientId')
        .leftJoin('users as u', 'u.id', 'c.userId')
        .innerJoin('services as s', 's.id', 'b.serviceId')
        .innerJoin('instructors as i', 'i.id', 'b.instructorId')
        .select((eb) => [
          'b.id',
          'b.startsAt',
          'b.endsAt',
          'b.createdAt',
          's.name as serviceName',
          'i.name as instructorName',
          eb.fn.coalesce('c.email', 'u.email').as('email'),
        ])
        .where('b.organizationId', '=', organizationId)
        .where('b.status', '=', 'confirmed')
        .where('b.startsAt', '>', now)
        .where('b.startsAt', '<=', new Date(now.getTime() + lead))
        .execute();
      for (const l of lessons) {
        if (!l.email) continue;
        // Lekcja zarezerwowana już po chwili przypomnienia: para pamięta, nie przypominamy.
        if (l.createdAt.getTime() > l.startsAt.getTime() - lead) continue;
        const deadline = cancelDeadline(l.startsAt, firm.cancelDeadlineHours);
        outgoing.push({
          kind: 'lesson_reminder',
          entityId: l.id,
          recipient: l.email,
          email: lessonReminderEmail({
            to: l.email,
            firmName: firm.name,
            serviceName: l.serviceName,
            day: formatDay(l.startsAt, tz),
            start: formatTime(l.startsAt, tz),
            end: formatTime(l.endsAt, tz),
            instructorName: l.instructorName,
            cancelUntil: deadline > now ? `${formatDate(deadline, tz)}, ${formatTime(deadline, tz)}` : null,
            calendarUrl: link(baseUrl, `/panel/${firm.slug}`),
          }),
        });
      }
    }

    // 2. Alerty dla szkoły o zdarzeniach z dziennika.
    const events = await tx
      .selectFrom('auditLog')
      .select(['action', 'entityId'])
      .where('organizationId', '=', organizationId)
      .where('action', 'in', ['payment.late', 'client.registered'])
      .where('createdAt', '>=', new Date(now.getTime() - ALERT_WINDOW_DAYS * DAY))
      .where('entityId', 'is not', null)
      .execute();
    if (events.length > 0) {
      const staff = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.userId')
        .select('u.email')
        .where('m.organizationId', '=', organizationId)
        .where('m.role', 'in', ['owner', 'admin'])
        .execute();
      const clientUrl = (clientId: string) => link(baseUrl, `/panel/${firm.slug}/klienci?para=${clientId}`);

      for (const event of events) {
        const entityId = event.entityId!;
        let alert: ((to: string) => Email) | null = null;
        let kind: EmailKind;
        if (event.action === 'payment.late') {
          kind = 'late_payment';
          const p = await tx
            .selectFrom('payments as p')
            .innerJoin('clients as c', 'c.id', 'p.clientId')
            .leftJoin('bookings as b', 'b.paymentId', 'p.id')
            .select(['p.amountCents', 'p.clientId', 'c.displayName', 'b.startsAt'])
            .where('p.organizationId', '=', organizationId)
            .where('p.id', '=', entityId)
            .executeTakeFirst();
          if (p) {
            alert = (to) =>
              latePaymentEmail({
                to,
                firmName: firm.name,
                clientName: p.displayName,
                amount: formatMoney(p.amountCents, firm.currency),
                lesson: p.startsAt ? `${formatDate(p.startsAt, tz)}, ${formatTime(p.startsAt, tz)}` : null,
                clientUrl: clientUrl(p.clientId),
              });
          }
        } else {
          kind = 'client_registered';
          const c = await tx
            .selectFrom('clients')
            .select((eb) => [
              'id',
              'displayName',
              'email',
              'phone',
              eb.fn<string | null>('to_char', [eb.ref('targetDate'), eb.val('YYYY-MM-DD')]).as('targetDate'),
            ])
            .where('organizationId', '=', organizationId)
            .where('id', '=', entityId)
            .executeTakeFirst();
          if (c) {
            alert = (to) =>
              clientRegisteredEmail({
                to,
                firmName: firm.name,
                clientName: c.displayName,
                email: c.email,
                phone: c.phone,
                weddingDate: weddingDate(c.targetDate),
                clientUrl: clientUrl(c.id),
              });
          }
        }
        if (!alert) continue;
        for (const { email } of staff) outgoing.push({ kind, entityId, recipient: email, email: alert(email) });
      }
    }
    if (outgoing.length === 0) return [];

    // 3. Rezerwacja: nowe maile dostają wiersz 'sending'; nieudane wcześniej (do MAX_ATTEMPTS prób) wracają do wysyłki.
    const key = (o: { kind: string; entityId: string; recipient: string }) => `${o.kind}|${o.entityId}|${lower(o.recipient)}`;
    const existing = await tx
      .selectFrom('emailNotifications')
      .select(['id', 'kind', 'entityId', 'recipient', 'status', 'attempts'])
      .where('organizationId', '=', organizationId)
      .where('entityId', 'in', [...new Set(outgoing.map((o) => o.entityId))])
      .execute();
    const known = new Map(existing.map((row) => [key(row), row]));

    const claimed: (Outgoing & { id: string })[] = [];
    const fresh = outgoing.filter((o) => !known.has(key(o)));
    if (fresh.length > 0) {
      // Drugi proces w tej samej chwili: unikalny klucz wpuści tylko jeden wiersz, a drugi nic nie dostanie.
      const inserted = await tx
        .insertInto('emailNotifications')
        .values(fresh.map((o) => ({ organizationId, kind: o.kind, entityId: o.entityId, recipient: o.recipient })))
        .onConflict((oc) => oc.columns(['organizationId', 'kind', 'entityId', 'recipient']).doNothing())
        .returning(['id', 'kind', 'entityId', 'recipient'])
        .execute();
      for (const row of inserted) {
        const o = fresh.find((candidate) => key(candidate) === key(row));
        if (o) claimed.push({ ...o, id: row.id });
      }
    }
    for (const o of outgoing) {
      const row = known.get(key(o));
      if (!row || row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS) continue;
      const retried = await tx
        .updateTable('emailNotifications')
        .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), updatedAt: now }))
        .where('id', '=', row.id)
        .where('status', '=', 'failed')
        .returning('id')
        .executeTakeFirst();
      if (retried) claimed.push({ ...o, id: row.id });
    }
    return claimed;
  });
}

/**
 * Wysyła maile jednej firmy: przypomnienia o lekcjach i alerty dla szkoły.
 * Wysyłka idzie poza transakcją bazy; wynik każdego maila zapisujemy zaraz po nim.
 */
export async function sendFirmEmails(
  db: Database,
  organizationId: string,
  deps: MailDeps,
  now: Date = new Date(),
): Promise<MailReport> {
  const claimed = await claimFirmEmails(db, organizationId, deps.baseUrl, now);
  const report: MailReport = { emailsSent: 0, emailsFailed: 0 };
  for (const mail of claimed) {
    let error: string | null = null;
    try {
      await deps.sendEmail(mail.email);
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500) || 'Nieznany błąd';
    }
    await withTenant(db, { organizationId, userId: null }, (tx) =>
      tx
        .updateTable('emailNotifications')
        .set(
          error === null
            ? { status: 'sent', sentAt: new Date(), updatedAt: new Date(), lastError: null }
            : { status: 'failed', updatedAt: new Date(), lastError: error },
        )
        .where('id', '=', mail.id)
        .execute(),
    );
    if (error === null) report.emailsSent++;
    else report.emailsFailed++;
  }
  return report;
}
