// Reguły grafiku: wyliczanie wolnych terminów (czysta funkcja, bez bazy).
// Przykłady liczbowe pochodzą z docs/decyzje.md („Reguły grafiku”).
import { describe, expect, it } from 'vitest';
import { isoWeekday, localTimeOf, localToInstant, timeToMinutes } from './local-time';
import { freeSlots, type AvailabilityException, type ScheduleSettings, type WeeklyHours } from './slots';

const TZ = 'Europe/Warsaw';
const DAY = '2027-01-11'; // poniedziałek, czas zimowy (UTC+1)

const at = (time: string, day = DAY) => new Date(localToInstant(day, timeToMinutes(time), TZ));
const NOW = at('09:00', '2027-01-04'); // tydzień przed DAY

const DEFAULTS: ScheduleSettings = {
  backToBackSlots: true,
  slotStepMinutes: 30,
  bufferMinutes: 0,
  minGapMinutes: 0,
  compactDays: false,
  minNoticeMinutes: 1440,
  maxAdvanceDays: 60,
};

const workHours = (day: string, from = '16:00', to = '21:00', extra: Partial<WeeklyHours> = {}): WeeklyHours => ({
  weekday: isoWeekday(day),
  startTime: from,
  endTime: to,
  validFrom: '2026-01-01',
  validTo: null,
  ...extra,
});

interface Options {
  day?: string;
  duration?: number;
  settings?: Partial<ScheduleSettings>;
  hours?: WeeklyHours[];
  exceptions?: AvailabilityException[];
  /** Zajęte przedziały w czasie lokalnym: [początek, koniec razem z przerwą]. */
  busy?: [string, string][];
  now?: Date;
}

/** Godziny (GG:MM) wolnych terminów w jednym dniu; domyślnie godziny pracy 16:00–21:00 i lekcje po 45 minut. */
function slotTimes(options: Options = {}): string[] {
  const day = options.day ?? DAY;
  return freeSlots({
    timeZone: TZ,
    now: options.now ?? NOW,
    from: day,
    to: day,
    durationMinutes: options.duration ?? 45,
    settings: { ...DEFAULTS, ...options.settings },
    hours: options.hours ?? [workHours(day)],
    exceptions: options.exceptions ?? [],
    busy: (options.busy ?? []).map(([start, end]) => ({ startsAt: at(start, day), blocksUntil: at(end, day) })),
  }).map((slot) => localTimeOf(slot.startsAt.getTime(), TZ));
}

describe('Wolne terminy: lekcje jedna po drugiej', () => {
  it('przy godzinach 16:00–21:00 i lekcjach po 45 minut terminy to 16:00, 16:45, 17:30, 18:15, 19:00 i 19:45, a ostatnich 30 minut nie da się zarezerwować', () => {
    expect(slotTimes()).toEqual(['16:00', '16:45', '17:30', '18:15', '19:00', '19:45']);
  });

  it('przerwa po lekcji: przy 15 minutach przerwy terminy to 16:00, 17:00, 18:00, 19:00 i 20:00', () => {
    expect(slotTimes({ settings: { bufferMinutes: 15 } })).toEqual(['16:00', '17:00', '18:00', '19:00', '20:00']);
  });

  it('po rezerwacji o innej godzinie następny termin zaczyna się zaraz po jej końcu, a wcześniejsze kończą się tuż przed nią: przy lekcji 17:00–17:45 terminy to 16:15, 17:45, 18:30, 19:15 i 20:00', () => {
    expect(slotTimes({ busy: [['17:00', '17:45']] })).toEqual(['16:15', '17:45', '18:30', '19:15', '20:00']);
  });

  it('lekcje przed rezerwacją przesuwają się pod nią: przy lekcji 17:45–18:30 terminy przed nią to 16:15 i 17:00, bez dziury', () => {
    expect(slotTimes({ busy: [['17:45', '18:30']] })).toEqual(['16:15', '17:00', '18:30', '19:15', '20:00']);
  });

  it('dzień z rezerwacją na końcu godzin pracy zaczyna się później, żeby lekcje szły jedna po drugiej aż do niej', () => {
    expect(slotTimes({ busy: [['20:15', '21:00']] })).toEqual(['16:30', '17:15', '18:00', '18:45', '19:30']);
  });

  it('między dwiema rezerwacjami terminy liczą się od końca wcześniejszej', () => {
    // Wolne 16:45–18:00 (75 minut): mieści się jedna lekcja, zaraz po rezerwacji 16:00–16:45.
    expect(slotTimes({ busy: [['16:00', '16:45'], ['18:00', '18:45']] })).toEqual(['16:45', '18:45', '19:30', '20:15']);
  });

  it('przerwa po wolnym terminie nie może zachodzić na kolejną rezerwację', () => {
    // Przed rezerwacją od 17:45 ostatni termin to 16:45: lekcja do 17:30 i przerwa do 17:45.
    // 17:00 zmieściłaby się, ale jej przerwa do 18:00 nachodziłaby na rezerwację.
    expect(slotTimes({ settings: { bufferMinutes: 15 }, busy: [['17:45', '18:30']] })).toEqual(['16:45', '18:30', '19:30']);
  });

  it('odcinek krótszy niż lekcja nie daje żadnego terminu', () => {
    expect(slotTimes({ busy: [['16:30', '21:00']] })).toEqual([]);
  });
});

describe('Wolne terminy: stała siatka (lekcje jedna po drugiej wyłączone)', () => {
  it('lekcje zaczynają się co slot_step_minutes od początku godzin pracy: 16:00, 16:30, 17:00…', () => {
    expect(slotTimes({ settings: { backToBackSlots: false, slotStepMinutes: 30 } })).toEqual([
      '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00',
    ]);
  });

  it('rezerwacja o innej godzinie nie przesuwa siatki: po lekcji 17:00–17:45 następny termin to 18:00', () => {
    expect(
      slotTimes({ duration: 60, settings: { backToBackSlots: false, slotStepMinutes: 30 }, busy: [['17:00', '17:45']] }),
    ).toEqual(['16:00', '18:00', '18:30', '19:00', '19:30', '20:00']);
  });
});

describe('Wolne terminy: minimalna przerwa (min_gap_minutes)', () => {
  const example = { duration: 60, busy: [['18:00', '19:00']] as [string, string][] };

  it('bez minimalnej przerwy siatka co 30 minut przy rezerwacji 18:00–19:00 daje 16:00, 16:30, 17:00, 19:00, 19:30 i 20:00', () => {
    expect(slotTimes({ ...example, settings: { backToBackSlots: false } })).toEqual([
      '16:00', '16:30', '17:00', '19:00', '19:30', '20:00',
    ]);
  });

  it('nie pokazuje terminów, które zostawiłyby przerwę krótszą niż min_gap_minutes: przy 60 minutach znikają 16:30 i 19:30', () => {
    expect(slotTimes({ ...example, settings: { backToBackSlots: false, minGapMinutes: 60 } })).toEqual([
      '16:00', '17:00', '19:00', '20:00',
    ]);
  });

  it('termin, który nie zostawia żadnej przerwy, jest zawsze pokazany', () => {
    // Odcinek 16:00–17:00 przed rezerwacją: lekcja 60 minut wypełnia go w całości.
    expect(
      slotTimes({ duration: 60, settings: { backToBackSlots: false, minGapMinutes: 120 }, busy: [['17:00', '21:00']] }),
    ).toEqual(['16:00']);
  });
});

describe('Wolne terminy: przyklejanie (compact_days)', () => {
  it('gdy dzień ma rezerwację, pokazuje tylko terminy tuż obok niej', () => {
    expect(slotTimes({ settings: { compactDays: true }, busy: [['18:15', '19:00']] })).toEqual(['17:30', '19:00']);
  });

  it('dzień bez rezerwacji pokazuje wszystkie terminy', () => {
    expect(slotTimes({ settings: { compactDays: true } })).toEqual(['16:00', '16:45', '17:30', '18:15', '19:00', '19:45']);
  });

  it('rezerwacja w innym dniu nie ogranicza terminów', () => {
    const otherDay = '2027-01-12';
    const slots = freeSlots({
      timeZone: TZ,
      now: NOW,
      from: DAY,
      to: DAY,
      durationMinutes: 45,
      settings: { ...DEFAULTS, compactDays: true },
      hours: [workHours(DAY)],
      exceptions: [],
      busy: [{ startsAt: at('17:00', otherDay), blocksUntil: at('17:45', otherDay) }],
    });
    expect(slots).toHaveLength(6);
  });
});

describe('Wolne terminy: wyprzedzenie i horyzont', () => {
  it('najkrótsze wyprzedzenie: nie pokazuje terminów wcześniejszych niż teraz plus min_notice_minutes', () => {
    // Dzień wcześniej o 17:00 przy wyprzedzeniu 24 h: najwcześniej 17:00 w dniu lekcji.
    expect(slotTimes({ now: at('17:00', '2027-01-10') })).toEqual(['17:30', '18:15', '19:00', '19:45']);
  });

  it('nie pokazuje terminów, które już minęły', () => {
    expect(slotTimes({ now: at('18:00'), settings: { minNoticeMinutes: 0 } })).toEqual(['18:15', '19:00', '19:45']);
  });

  it('horyzont: można rezerwować najdalej max_advance_days dni naprzód (liczone w dniach kalendarzowych)', () => {
    // NOW to 2027-01-04, więc 2027-01-11 jest za 7 dni.
    expect(slotTimes({ settings: { maxAdvanceDays: 7 } })).toHaveLength(6);
    expect(slotTimes({ settings: { maxAdvanceDays: 6 } })).toEqual([]);
  });
});

describe('Wolne terminy: godziny pracy i wyjątki', () => {
  it('wolne i urlop (unavailable) usuwają terminy z grafiku', () => {
    const exceptions: AvailabilityException[] = [{ kind: 'unavailable', startsAt: at('16:00'), endsAt: at('18:00') }];
    expect(slotTimes({ exceptions })).toEqual(['18:00', '18:45', '19:30', '20:15']);
  });

  it('dodatkowe godziny (extra) dodają terminy poza stałymi godzinami pracy', () => {
    const exceptions: AvailabilityException[] = [{ kind: 'extra', startsAt: at('10:00'), endsAt: at('12:00') }];
    expect(slotTimes({ exceptions }).slice(0, 3)).toEqual(['10:00', '10:45', '16:00']);
  });

  it('dzień bez stałych godzin pracy nie ma terminów', () => {
    expect(slotTimes({ hours: [workHours('2027-01-12')] })).toEqual([]);
  });

  it('stałe godziny obowiązują tylko od valid_from do valid_to', () => {
    expect(slotTimes({ hours: [workHours(DAY, '16:00', '21:00', { validTo: '2027-01-10' })] })).toEqual([]);
    expect(slotTimes({ hours: [workHours(DAY, '16:00', '21:00', { validFrom: '2027-01-12' })] })).toEqual([]);
    expect(slotTimes({ hours: [workHours(DAY, '16:00', '21:00', { validFrom: DAY, validTo: DAY })] })).toHaveLength(6);
  });

  it('godziny pracy zostają w czasie lokalnym po zmianie czasu w marcu i październiku', () => {
    const firstSlot = (day: string, now: string) =>
      freeSlots({
        timeZone: TZ,
        now: new Date(now),
        from: day,
        to: day,
        durationMinutes: 45,
        settings: DEFAULTS,
        hours: [workHours(day)],
        exceptions: [],
        busy: [],
      })[0]?.startsAt.toISOString();

    expect(firstSlot('2027-03-22', '2027-03-01T08:00:00Z')).toBe('2027-03-22T15:00:00.000Z'); // UTC+1
    expect(firstSlot('2027-03-29', '2027-03-01T08:00:00Z')).toBe('2027-03-29T14:00:00.000Z'); // UTC+2
    expect(firstSlot('2027-10-25', '2027-10-01T08:00:00Z')).toBe('2027-10-25T14:00:00.000Z'); // UTC+2
    expect(firstSlot('2027-11-01', '2027-10-01T08:00:00Z')).toBe('2027-11-01T15:00:00.000Z'); // UTC+1
  });

  it('przy kilku dniach terminy są posortowane od najwcześniejszego', () => {
    const nextDay = '2027-01-12';
    const slots = freeSlots({
      timeZone: TZ,
      now: NOW,
      from: DAY,
      to: nextDay,
      durationMinutes: 45,
      settings: DEFAULTS,
      hours: [workHours(nextDay, '10:00', '12:00'), workHours(DAY)],
      exceptions: [],
      busy: [],
    });
    const times = slots.map((s) => s.startsAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(slots).toHaveLength(8);
  });

  it('każdy termin podaje koniec lekcji i koniec blokady kalendarza (z przerwą)', () => {
    const [first] = freeSlots({
      timeZone: TZ,
      now: NOW,
      from: DAY,
      to: DAY,
      durationMinutes: 45,
      settings: { ...DEFAULTS, bufferMinutes: 15 },
      hours: [workHours(DAY)],
      exceptions: [],
      busy: [],
    });
    expect(first).toEqual({ startsAt: at('16:00'), endsAt: at('16:45'), blocksUntil: at('17:00') });
  });
});
