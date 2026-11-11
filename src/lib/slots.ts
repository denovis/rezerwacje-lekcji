// Wolne terminy instruktora: czysta funkcja, bez bazy i bez zegara („teraz” podajemy z zewnątrz).
//
// Kolejność liczenia (opis reguł: docs/decyzje.md, „Reguły grafiku”):
//  1. Okna dostępności: stałe godziny pracy w czasie lokalnym firmy plus dodatkowe godziny (extra),
//     minus wolne i urlopy (unavailable).
//  2. Wolne odcinki: okna minus zajęte przedziały rezerwacji [początek, koniec + przerwa).
//  3. Starty: jedna po drugiej (co długość lekcji + przerwa, „przyklejone” do rezerwacji)
//     albo co stałą liczbę minut (siatka liczona od początku okna dostępności).
//     Jedna po drugiej: odcinek, który kończy się rezerwacją (a nie zaczyna inną), liczymy wstecz
//     od jej początku, żeby nie zostawić dziury przed rezerwacją. Pozostałe odcinki liczymy od początku.
//     Lekcja musi zmieścić się w odcinku, a jej przerwa nie może zachodzić na inną rezerwację.
//  4. Reguły: przyklejanie (compact_days), minimalna przerwa (min_gap_minutes),
//     najkrótsze wyprzedzenie (min_notice_minutes) i horyzont (max_advance_days).
import { addDays, isoWeekday, localDateOf, localToInstant, timeToMinutes } from './local-time';

const MINUTE = 60_000;

/** Ustawienia grafiku firmy (organization_settings). */
export interface ScheduleSettings {
  backToBackSlots: boolean;
  slotStepMinutes: number;
  bufferMinutes: number;
  minGapMinutes: number;
  compactDays: boolean;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
}

/** Stałe godziny pracy w tygodniu (availability_rules), w czasie lokalnym firmy. */
export interface WeeklyHours {
  /** 1 = poniedziałek … 7 = niedziela. */
  weekday: number;
  /** GG:MM albo GG:MM:SS. */
  startTime: string;
  endTime: string;
  /** Pierwszy i ostatni dzień obowiązywania (RRRR-MM-DD, włącznie); validTo null = bez końca. */
  validFrom: string;
  validTo: string | null;
}

/** Wyjątek od stałych godzin (availability_exceptions), w czasie bezwzględnym. */
export interface AvailabilityException {
  kind: 'unavailable' | 'extra';
  startsAt: Date;
  endsAt: Date;
}

/** Zajęty przedział instruktora: rezerwacja razem z przerwą po niej. */
export interface BusyPeriod {
  startsAt: Date;
  blocksUntil: Date;
}

export interface SlotQuery {
  /** Strefa czasowa firmy, np. Europe/Warsaw. */
  timeZone: string;
  now: Date;
  /** Pierwszy i ostatni dzień (lokalnie, RRRR-MM-DD, włącznie). */
  from: string;
  to: string;
  /** Długość lekcji z usługi (services.duration_minutes). */
  durationMinutes: number;
  settings: ScheduleSettings;
  hours: WeeklyHours[];
  exceptions: AvailabilityException[];
  busy: BusyPeriod[];
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  /** Koniec lekcji plus przerwa: do tej chwili rezerwacja blokuje kalendarz. */
  blocksUntil: Date;
}

interface Interval {
  start: number;
  end: number;
}

/** Łączy nachodzące na siebie i stykające się przedziały. */
function merge(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Przedziały z base po wycięciu wszystkich przedziałów z cuts. */
function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let result = base;
  for (const cut of cuts) {
    const next: Interval[] = [];
    for (const i of result) {
      if (cut.end <= i.start || cut.start >= i.end) {
        next.push(i);
        continue;
      }
      if (cut.start > i.start) next.push({ start: i.start, end: cut.start });
      if (cut.end < i.end) next.push({ start: cut.end, end: i.end });
    }
    result = next;
  }
  return result;
}

/** Wolne terminy jednego instruktora dla jednej usługi, posortowane od najwcześniejszego. */
export function freeSlots(q: SlotQuery): Slot[] {
  const { timeZone, settings } = q;
  const now = q.now.getTime();

  // Horyzont liczymy w dniach kalendarzowych: cały dzień otwiera się o północy czasu lokalnego.
  const today = localDateOf(now, timeZone);
  const lastBookableDay = addDays(today, settings.maxAdvanceDays);
  const from = q.from > today ? q.from : today;
  const to = q.to < lastBookableDay ? q.to : lastBookableDay;
  if (from > to) return [];

  const duration = q.durationMinutes * MINUTE;
  const buffer = settings.bufferMinutes * MINUTE;
  const minGap = settings.minGapMinutes * MINUTE;
  const earliestStart = now + settings.minNoticeMinutes * MINUTE;
  const step = settings.backToBackSlots ? duration + buffer : settings.slotStepMinutes * MINUTE;
  if (duration <= 0 || step <= 0) return [];

  // 1. Okna dostępności.
  const hourWindows: Interval[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const weekday = isoWeekday(day);
    for (const h of q.hours) {
      if (h.weekday !== weekday || day < h.validFrom || (h.validTo !== null && day > h.validTo)) continue;
      hourWindows.push({
        start: localToInstant(day, timeToMinutes(h.startTime), timeZone),
        end: localToInstant(day, timeToMinutes(h.endTime), timeZone),
      });
    }
  }
  const rangeStart = localToInstant(from, 0, timeZone);
  const rangeEnd = localToInstant(addDays(to, 1), 0, timeZone);
  const toInterval = (e: AvailabilityException): Interval => ({ start: e.startsAt.getTime(), end: e.endsAt.getTime() });
  const extra = q.exceptions
    .filter((e) => e.kind === 'extra')
    .map(toInterval)
    .filter((i) => i.end > rangeStart && i.start < rangeEnd);
  const unavailable = q.exceptions.filter((e) => e.kind === 'unavailable').map(toInterval);
  const windows = subtract(merge([...hourWindows, ...extra]), unavailable);

  const busy = q.busy
    .map((b) => ({ start: b.startsAt.getTime(), end: b.blocksUntil.getTime() }))
    .filter((b) => b.end > b.start);
  const daysWithBookings = new Set(busy.map((b) => localDateOf(b.start, timeZone)));
  const blockIsFree = (start: number) => !busy.some((b) => start < b.end && start + duration + buffer > b.start);

  const result: number[] = [];
  for (const window of windows) {
    // 2. Wolne odcinki okna.
    for (const free of subtract([window], busy)) {
      const rightAfterBooking = busy.some((b) => b.end === free.start);
      const rightBeforeBooking = busy.some((b) => b.start === free.end);

      // 3. Starty w odcinku.
      let starts: number[] = [];
      if (settings.backToBackSlots && rightBeforeBooking && !rightAfterBooking) {
        // Wstecz od rezerwacji: ostatnia lekcja razem z przerwą kończy się dokładnie, gdy zaczyna się rezerwacja.
        for (let start = free.end - step; start >= free.start; start -= step) {
          if (blockIsFree(start)) starts.unshift(start);
        }
      } else {
        let start = settings.backToBackSlots
          ? free.start
          : window.start + Math.ceil((free.start - window.start) / step) * step;
        for (; start + duration <= free.end; start += step) {
          if (blockIsFree(start)) starts.push(start);
        }
      }

      // 4a. Przyklejanie: w dniu z rezerwacją tylko termin tuż po niej i tuż przed nią.
      if (settings.compactDays && starts.length > 0) {
        const first = starts[0];
        const last = starts.at(-1);
        starts = starts.filter(
          (s) =>
            !daysWithBookings.has(localDateOf(s, timeZone)) ||
            (s === first && rightAfterBooking) ||
            (s === last && rightBeforeBooking),
        );
      }

      // 4b. Minimalna przerwa: wolny czas z każdej strony lekcji to 0 albo co najmniej min_gap_minutes.
      if (minGap > 0) {
        starts = starts.filter((s) => {
          const before = s - free.start;
          const after = Math.max(0, free.end - (s + duration + buffer));
          return (before === 0 || before >= minGap) && (after === 0 || after >= minGap);
        });
      }

      // 4c. Wyprzedzenie i zakres dni.
      for (const s of starts) {
        if (s < earliestStart) continue;
        const day = localDateOf(s, timeZone);
        if (day < from || day > to) continue;
        result.push(s);
      }
    }
  }

  return result
    .sort((a, b) => a - b)
    .map((s) => ({ startsAt: new Date(s), endsAt: new Date(s + duration), blocksUntil: new Date(s + duration + buffer) }));
}
