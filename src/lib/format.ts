// Teksty w interfejsie: daty w strefie firmy, statusy i odmiana liczebników po polsku.
// Bez kodu serwera: korzysta z tego także kalendarz w przeglądarce.
import type { BookingStatus, ClientStatus } from './db-types';

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending_payment: 'czeka na płatność',
  confirmed: 'zarezerwowana',
  completed: 'odbyta',
  no_show: 'nieobecność',
  cancelled: 'odwołana',
  late_cancelled: 'odwołana po terminie',
  expired: 'nieopłacona w terminie',
};

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  new: 'nowy',
  regular: 'stały',
  trusted: 'zaufany',
};

/** Np. „poniedziałek, 11 stycznia”. */
export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

/** Np. „11 stycznia” (dopełniacz, więc pasuje po „do”, „od”). */
export function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { timeZone, day: 'numeric', month: 'long' }).format(date);
}

/** Krótka nazwa dnia tygodnia do nagłówka kalendarza, np. „pon.”. */
export function formatWeekdayShort(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { timeZone, weekday: 'short' }).format(date);
}

/** Zakres dni tygodnia w nagłówku kalendarza, np. „9–15 listopada 2026” albo „30 listopada – 6 grudnia 2026”. */
export function formatWeekRange(first: string, last: string): string {
  const noon = (date: string) => new Date(`${date}T12:00:00Z`);
  const dayMonth = (date: string) => formatDate(noon(date), 'UTC');
  const [firstYear, lastYear] = [first.slice(0, 4), last.slice(0, 4)];
  if (first.slice(0, 7) === last.slice(0, 7)) return `${Number(first.slice(8, 10))}–${dayMonth(last)} ${lastYear}`;
  if (firstYear === lastYear) return `${dayMonth(first)} – ${dayMonth(last)} ${lastYear}`;
  return `${dayMonth(first)} ${firstYear} – ${dayMonth(last)} ${lastYear}`;
}

/** Np. „16:45”. */
export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Liczba z rzeczownikiem w odpowiedniej formie, np. 1 lekcja, 2 lekcje, 5 lekcji, −1 lekcja. */
export function pluralize(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(count);
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  const word = n === 1 ? one : lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
  return `${count < 0 ? '−' : ''}${n} ${word}`;
}

export function lessonsLabel(count: number): string {
  return pluralize(count, 'lekcja', 'lekcje', 'lekcji');
}
