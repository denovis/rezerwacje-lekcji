// Odczyty do stron panelu: profil klienta z saldem, lekcje klienta i grafik szkoły.
// Klient widzi tylko swoje lekcje; listę klientów i cały grafik widzi szkoła (właściciel, admin).
import { actorOf, BookingError, loadFirmRules, type FirmContext } from './bookings';
import { withTenant, type Database } from './db';
import type { BookingStatus, ClientStatus, MemberRole } from './db-types';

export interface ClientProfile {
  id: string;
  displayName: string;
  status: ClientStatus;
  creditLimit: number;
  /** Saldo lekcji: suma wpisów w historii (credit_entries). */
  balance: number;
}

export interface FirmOverview {
  role: MemberRole | null;
  isStaff: boolean;
  client: ClientProfile | null;
  services: { id: string; name: string; durationMinutes: number; creditCost: number }[];
  instructors: { id: string; name: string }[];
  timeZone: string;
  cancelDeadlineHours: number;
}

/** Podstawowe dane wybranej firmy z punktu widzenia zalogowanej osoby. */
export function firmOverview(db: Database, ctx: FirmContext): Promise<FirmOverview> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    const rules = await loadFirmRules(tx, ctx.organizationId);
    const client = actor.ownClientId
      ? await tx
          .selectFrom('clients as c')
          .leftJoin('clientBalances as b', 'b.clientId', 'c.id')
          .select(['c.id', 'c.displayName', 'c.status', 'c.creditLimit', 'b.balance'])
          .where('c.id', '=', actor.ownClientId)
          .executeTakeFirst()
      : undefined;
    const services = await tx
      .selectFrom('services')
      .select(['id', 'name', 'durationMinutes', 'creditCost'])
      .where('active', '=', true)
      .orderBy('name')
      .execute();
    const instructors = await tx
      .selectFrom('instructors')
      .select(['id', 'name'])
      .where('active', '=', true)
      .orderBy('name')
      .execute();
    return {
      role: actor.role,
      isStaff: actor.isStaff,
      client: client ? { ...client, balance: client.balance ?? 0 } : null,
      services,
      instructors,
      timeZone: rules.timeZone,
      cancelDeadlineHours: rules.cancelDeadlineHours,
    };
  });
}

/** Strefa czasowa firmy (do przeliczenia daty i godziny wpisanej w formularzu). */
export function firmTimeZone(db: Database, ctx: FirmContext): Promise<string> {
  return withTenant(db, ctx, async (tx) => (await loadFirmRules(tx, ctx.organizationId)).timeZone);
}

export interface BookingRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  clientId: string;
  clientName: string;
  instructorName: string;
  serviceName: string;
}

export interface BookingFilter {
  /** Tylko lekcje tego klienta. Klient zawsze widzi tylko swoje, bez względu na ten parametr. */
  clientId?: string;
  /** Lekcje zaczynające się od tej chwili (włącznie) … */
  from: Date;
  /** … i przed tą chwilą. */
  to?: Date;
  /** Domyślnie wszystkie poza wygasłymi blokadami płatności. */
  statuses?: BookingStatus[];
}

const VISIBLE_STATUSES: BookingStatus[] = ['pending_payment', 'confirmed', 'completed', 'no_show', 'cancelled', 'late_cancelled'];

/** Lekcje od najwcześniejszej: dla klienta jego własne, dla szkoły wszystkie (albo wybranego klienta). */
export function listBookings(db: Database, ctx: FirmContext, filter: BookingFilter): Promise<BookingRow[]> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    const clientId = actor.isStaff ? filter.clientId : actor.ownClientId;
    if (!actor.isStaff && !clientId) return [];

    let query = tx
      .selectFrom('bookings as b')
      .innerJoin('clients as c', 'c.id', 'b.clientId')
      .innerJoin('instructors as i', 'i.id', 'b.instructorId')
      .innerJoin('services as s', 's.id', 'b.serviceId')
      .select([
        'b.id',
        'b.startsAt',
        'b.endsAt',
        'b.status',
        'b.clientId',
        'c.displayName as clientName',
        'i.name as instructorName',
        's.name as serviceName',
      ])
      .where('b.startsAt', '>=', filter.from)
      .where('b.status', 'in', filter.statuses ?? VISIBLE_STATUSES);
    if (filter.to) query = query.where('b.startsAt', '<', filter.to);
    if (clientId) query = query.where('b.clientId', '=', clientId);
    return query.orderBy('b.startsAt').orderBy('i.name').execute();
  });
}

export interface ClientListItem {
  id: string;
  displayName: string;
  status: ClientStatus;
  balance: number;
}

/** Klienci firmy z saldem (tylko dla szkoły). */
export function listClients(db: Database, ctx: FirmContext): Promise<ClientListItem[]> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    if (!actor.isStaff) throw new BookingError('not_allowed');
    const rows = await tx
      .selectFrom('clients as c')
      .leftJoin('clientBalances as b', 'b.clientId', 'c.id')
      .select(['c.id', 'c.displayName', 'c.status', 'b.balance'])
      .where('c.organizationId', '=', ctx.organizationId)
      .execute();
    return rows
      .map((row) => ({ ...row, balance: row.balance ?? 0 }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pl'));
  });
}
