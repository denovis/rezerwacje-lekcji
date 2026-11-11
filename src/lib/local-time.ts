// Czas lokalny firmy (organizations.timezone) a czas bezwzględny.
//
// Stałe godziny pracy są zapisane w czasie lokalnym (np. poniedziałek 16:00–21:00), a rezerwacje
// jako chwile w czasie (timestamptz). Przeliczenie uwzględnia zmianę czasu w marcu i październiku,
// więc 16:00 zostaje 16:00 przez cały rok. Bez zewnętrznych bibliotek: wystarcza Intl.
//
// Daty lokalne zapisujemy jako tekst RRRR-MM-DD, a chwile jako liczbę milisekund (jak Date.getTime()).

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Lokalna data i godzina w strefie, rozbite na liczby. */
function localParts(instant: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Przesunięcie strefy względem UTC w minutach w danej chwili, np. 60 dla Warszawy zimą i 120 latem. */
export function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const wholeSeconds = Math.floor(instant / 1000) * 1000;
  const p = localParts(wholeSeconds, timeZone);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((localAsUtc - wholeSeconds) / MINUTE);
}

/** Rozbija datę RRRR-MM-DD na liczby; rzuca błąd przy złym formacie. */
function parseDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Zły format daty: „${date}” (oczekiwano RRRR-MM-DD).`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return d.toISOString().slice(0, 10) === value;
}

/**
 * Chwila odpowiadająca lokalnej dacie i godzinie w strefie firmy,
 * np. 2027-03-29 i 16:00 w Europe/Warsaw → 2027-03-29T14:00:00Z (czas letni).
 * minutesOfDay może wynosić 1440 (24:00 = północ następnego dnia).
 * Godzina, której nie ma (noc zmiany czasu w marcu), przesuwa się o godzinę do przodu;
 * godzina, która jest dwa razy (noc zmiany w październiku), oznacza tę drugą.
 */
export function localToInstant(date: string, minutesOfDay: number, timeZone: string): number {
  const [year, month, day] = parseDate(date);
  const wallClockAsUtc = Date.UTC(year, month - 1, day) + minutesOfDay * MINUTE;
  const firstOffset = zoneOffsetMinutes(wallClockAsUtc, timeZone);
  const guess = wallClockAsUtc - firstOffset * MINUTE;
  const secondOffset = zoneOffsetMinutes(guess, timeZone);
  return secondOffset === firstOffset ? guess : wallClockAsUtc - secondOffset * MINUTE;
}

/** Lokalna data (RRRR-MM-DD) chwili w strefie firmy. */
export function localDateOf(instant: number, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Lokalna godzina (GG:MM) chwili w strefie firmy. */
export function localTimeOf(instant: number, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Data przesunięta o podaną liczbę dni (kalendarzowo, bez względu na zmianę czasu). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY).toISOString().slice(0, 10);
}

/** Dzień tygodnia według ISO: 1 = poniedziałek … 7 = niedziela. */
export function isoWeekday(date: string): number {
  const [year, month, day] = parseDate(date);
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

/** Godzina z bazy (typ time, np. 16:00:00) albo z formularza (16:00) jako minuty od północy. */
export function timeToMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw new Error(`Zły format godziny: „${time}” (oczekiwano GG:MM).`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes > 24 * 60 || Number(match[2]) > 59) throw new Error(`Zła godzina: „${time}”.`);
  return minutes;
}
