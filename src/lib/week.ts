// Tydzień w kalendarzu panelu: lekcje, wolne terminy i zakres godzin, w czasie lokalnym firmy.
// Klient widzi swoje lekcje i wolne terminy; szkoła (właściciel, admin) lekcje wszystkich klientów.
import { BLOCKING_STATUSES, cancelDeadline, listFreeSlots, type FirmContext, type OpenSlot } from './bookings';
import { firmOverview, listBookings, listClients, type BookingRow, type ClientListItem } from './calendar';
import { withTenant, type Database } from './db';
import {
  BOOKING_STATUS_LABELS,
  CLIENT_STATUS_LABELS,
  formatDate,
  formatDay,
  formatTime,
  formatWeekdayShort,
  formatWeekRange,
  lessonsLabel,
} from './format';
import { addDays, isLocalDate, isoWeekday, localDateOf, localTimeOf, localToInstant, timeToMinutes } from './local-time';
import { gridRange, type CalendarLesson, type CalendarSlot, type Timed, type WeekData } from './week-layout';

const FULL_DAY = 24 * 60;

/** Poniedziałek tygodnia, w którym jest podany dzień. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Minuty od północy dnia `date` w strefie firmy; chwila z następnego dnia to 24:00. */
function minutesInDay(instant: Date, date: string, timeZone: string): number {
  const day = localDateOf(instant.getTime(), timeZone);
  if (day > date) return FULL_DAY;
  if (day < date) return 0;
  return timeToMinutes(localTimeOf(instant.getTime(), timeZone));
}

export interface WeekQuery {
  /** Dowolny dzień tygodnia (RRRR-MM-DD); domyślnie dzisiejszy tydzień. */
  week?: string;
  serviceId?: string;
  now?: Date;
}

/**
 * Dane tygodnia do kalendarza. Null, gdy zalogowana osoba nie jest ani klientem, ani szkołą
 * (np. sam instruktor — jego grafik będzie w kolejnej wersji).
 */
export async function loadWeek(db: Database, ctx: FirmContext, query: WeekQuery = {}): Promise<WeekData | null> {
  const now = query.now ?? new Date();
  const overview = await firmOverview(db, ctx);
  if (!overview.isStaff && !overview.client) return null;

  const timeZone = overview.timeZone;
  const today = localDateOf(now.getTime(), timeZone);
  const weekStart = mondayOf(query.week && isLocalDate(query.week) ? query.week : today);
  const weekEnd = addDays(weekStart, 6);
  const service = overview.services.find((s) => s.id === query.serviceId) ?? overview.services[0] ?? null;
  const clientId = overview.client?.id;

  const [bookings, openSlots, clients, upcoming, workHours] = await Promise.all([
    listBookings(db, ctx, {
      clientId: overview.isStaff ? undefined : clientId,
      from: new Date(localToInstant(weekStart, 0, timeZone)),
      to: new Date(localToInstant(addDays(weekEnd, 1), 0, timeZone)),
    }),
    service ? listFreeSlots(db, ctx, { serviceId: service.id, from: weekStart, to: weekEnd, now }) : Promise.resolve<OpenSlot[]>([]),
    overview.isStaff ? listClients(db, ctx) : Promise.resolve<ClientListItem[]>([]),
    clientId
      ? listBookings(db, ctx, { clientId, from: now, statuses: ['pending_payment', 'confirmed'] })
      : Promise.resolve<BookingRow[]>([]),
    workHoursRange(db, ctx),
  ]);

  const lessons = bookings.map((booking): CalendarLesson => {
    const date = localDateOf(booking.startsAt.getTime(), timeZone);
    const deadline = cancelDeadline(booking.startsAt, overview.cancelDeadlineHours);
    const cancellable = booking.status === 'confirmed' && booking.startsAt > now;
    return {
      id: booking.id,
      date,
      start: minutesInDay(booking.startsAt, date, timeZone),
      end: minutesInDay(booking.endsAt, date, timeZone),
      timeLabel: `${formatTime(booking.startsAt, timeZone)}–${formatTime(booking.endsAt, timeZone)}`,
      dateLabel: formatDay(booking.startsAt, timeZone),
      status: booking.status,
      statusLabel: BOOKING_STATUS_LABELS[booking.status],
      blocksCalendar: BLOCKING_STATUSES.includes(booking.status),
      clientName: booking.clientName,
      instructorName: booking.instructorName,
      serviceName: booking.serviceName,
      cancel: cancellable
        ? {
            refundable: now.getTime() <= deadline.getTime(),
            deadlineLabel: `${formatDate(deadline, timeZone)}, godz. ${formatTime(deadline, timeZone)}`,
          }
        : null,
    };
  });

  const slots = openSlots.map((slot): CalendarSlot => {
    const date = localDateOf(slot.startsAt.getTime(), timeZone);
    return {
      key: `${slot.instructorId}|${slot.startsAt.toISOString()}`,
      instructorId: slot.instructorId,
      instructorName: slot.instructorName,
      startsAt: slot.startsAt.toISOString(),
      date,
      start: minutesInDay(slot.startsAt, date, timeZone),
      end: minutesInDay(slot.endsAt, date, timeZone),
      timeLabel: `${formatTime(slot.startsAt, timeZone)}–${formatTime(slot.endsAt, timeZone)}`,
      dateLabel: formatDay(slot.startsAt, timeZone),
    };
  });

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    const noon = new Date(localToInstant(date, 12 * 60, timeZone));
    return {
      date,
      weekdayShort: formatWeekdayShort(noon, timeZone),
      dayOfMonth: Number(date.slice(8, 10)),
      label: formatDay(noon, timeZone),
      isToday: date === today,
      isPast: date < today,
    };
  });

  const next = upcoming[0];
  return {
    timeZone,
    weekStart,
    previousWeek: addDays(weekStart, -7),
    nextWeek: addDays(weekStart, 7),
    currentWeek: mondayOf(today),
    title: formatWeekRange(weekStart, weekEnd),
    days,
    now: { date: today, minutes: minutesInDay(now, today, timeZone) },
    range: gridRange(workHours, [...lessons.filter((l) => l.blocksCalendar), ...slots]),
    isStaff: overview.isStaff,
    client: overview.client
      ? {
          id: overview.client.id,
          balance: overview.client.balance,
          balanceLabel: lessonsLabel(overview.client.balance),
          creditLimit: overview.client.creditLimit,
        }
      : null,
    upcoming: next
      ? {
          count: upcoming.length,
          nextLabel: `${formatDay(next.startsAt, timeZone)}, ${formatTime(next.startsAt, timeZone)}`,
          nextWeek: mondayOf(localDateOf(next.startsAt.getTime(), timeZone)),
        }
      : null,
    clients: clients.map((c) => ({
      id: c.id,
      name: c.displayName,
      label: `${c.displayName} · ${CLIENT_STATUS_LABELS[c.status]} · ${lessonsLabel(c.balance)}`,
      balance: c.balance,
    })),
    instructors: overview.instructors,
    services: overview.services.map((s) => ({ id: s.id, name: s.name })),
    service,
    lessons,
    slots,
  };
}

/** Od najwcześniejszego początku do najpóźniejszego końca stałych godzin pracy aktywnych instruktorów. */
function workHoursRange(db: Database, ctx: FirmContext): Promise<Timed | null> {
  return withTenant(db, ctx, async (tx) => {
    const row = await tx
      .selectFrom('availabilityRules as r')
      .innerJoin('instructors as i', 'i.id', 'r.instructorId')
      .select((eb) => [eb.fn.min<string | null>('r.startTime').as('start'), eb.fn.max<string | null>('r.endTime').as('end')])
      .where('i.active', '=', true)
      .executeTakeFirst();
    if (!row?.start || !row.end) return null;
    return { start: timeToMinutes(row.start), end: timeToMinutes(row.end) };
  });
}
