// Kalendarz tygodniowy: dane przekazywane do przeglądarki i układ bloków w siatce godzin.
// Bez kodu serwera: z tego pliku korzysta komponent kalendarza ('use client').
// Czas jest już przeliczony na czas lokalny firmy: dzień RRRR-MM-DD i minuty od północy.
import type { BookingStatus } from './db-types';

/** Odcinek w dniu: od–do w minutach od północy czasu lokalnego firmy. */
export interface Timed {
  start: number;
  end: number;
}

export interface CalendarDay {
  date: string;
  /** Np. „pon.”. */
  weekdayShort: string;
  dayOfMonth: number;
  /** Np. „poniedziałek, 9 listopada”. */
  label: string;
  isToday: boolean;
  isPast: boolean;
}

export interface CalendarLesson extends Timed {
  id: string;
  date: string;
  /** Np. „17:30–18:15”. */
  timeLabel: string;
  /** Np. „czwartek, 12 listopada”. */
  dateLabel: string;
  status: BookingStatus;
  statusLabel: string;
  /** Lekcja zajmuje termin (widać ją w siatce); odwołane widać tylko na liście. */
  blocksCalendar: boolean;
  clientName: string;
  instructorName: string;
  serviceName: string;
  /** Null: lekcji nie można już odwołać (zaczęła się, odbyła albo jest odwołana). */
  cancel: { refundable: boolean; deadlineLabel: string } | null;
}

export interface CalendarSlot extends Timed {
  key: string;
  instructorId: string;
  instructorName: string;
  /** Początek lekcji (ISO) do wysłania przy rezerwacji. */
  startsAt: string;
  date: string;
  timeLabel: string;
  dateLabel: string;
}

export interface WeekData {
  timeZone: string;
  /** Poniedziałek tygodnia (RRRR-MM-DD). */
  weekStart: string;
  previousWeek: string;
  nextWeek: string;
  currentWeek: string;
  /** Np. „9–15 listopada 2026”. */
  title: string;
  days: CalendarDay[];
  now: { date: string; minutes: number };
  /** Zakres godzin siatki: pełne godziny, stały z tygodnia na tydzień (godziny pracy + lekcje). */
  range: Timed;
  isStaff: boolean;
  /** Profil klienta zalogowanej osoby. */
  client: { id: string; balance: number; balanceLabel: string; creditLimit: number } | null;
  /** Najbliższe zaplanowane lekcje klienta (także w kolejnych tygodniach). */
  upcoming: { count: number; nextLabel: string; nextWeek: string } | null;
  /** Klienci do wyboru przy rezerwacji (tylko dla szkoły). */
  clients: { id: string; name: string; label: string; balance: number }[];
  instructors: { id: string; name: string }[];
  services: { id: string; name: string }[];
  service: { id: string; name: string; durationMinutes: number; creditCost: number } | null;
  lessons: CalendarLesson[];
  slots: CalendarSlot[];
}

export interface Placed<T> {
  item: T;
  /** Kolumna w grupie nachodzących na siebie bloków (od 0). */
  column: number;
  /** Liczba kolumn w tej grupie: blok zajmuje 1/columns szerokości dnia. */
  columns: number;
}

/**
 * Układ bloków jednego dnia jak w Google Calendar: nachodzące na siebie bloki stoją obok siebie,
 * a blok, który na nic nie nachodzi, zajmuje całą szerokość.
 */
export function layoutDay<T extends Timed>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const result: Placed<T>[] = [];
  let group: { item: T; column: number }[] = [];
  let columnEnds: number[] = [];
  let groupEnd = -Infinity;

  const closeGroup = () => {
    for (const placed of group) result.push({ ...placed, columns: columnEnds.length });
    group = [];
    columnEnds = [];
    groupEnd = -Infinity;
  };

  for (const item of sorted) {
    if (group.length > 0 && item.start >= groupEnd) closeGroup();
    let column = columnEnds.findIndex((end) => end <= item.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.end);
    } else {
      columnEnds[column] = item.end;
    }
    group.push({ item, column });
    groupEnd = Math.max(groupEnd, item.end);
  }
  closeGroup();
  return result;
}

/** Domyślny zakres siatki, gdy firma nie ma jeszcze godzin pracy ani lekcji. */
export const DEFAULT_RANGE: Timed = { start: 8 * 60, end: 20 * 60 };

/** Zakres godzin siatki: godziny pracy i wszystkie bloki, rozszerzony do pełnych godzin. */
export function gridRange(workHours: Timed | null, items: Timed[]): Timed {
  const all = workHours ? [workHours, ...items] : items;
  if (all.length === 0) return DEFAULT_RANGE;
  const start = Math.min(...all.map((i) => i.start));
  const end = Math.max(...all.map((i) => i.end));
  return { start: Math.floor(start / 60) * 60, end: Math.min(24 * 60, Math.max(start + 60, Math.ceil(end / 60) * 60)) };
}
