// Teksty w interfejsie po polsku.
import { describe, expect, it } from 'vitest';
import { formatDate, formatDay, formatTime, formatWeekRange, lessonsLabel } from './format';

describe('Teksty w interfejsie', () => {
  it('liczba lekcji odmienia się po polsku: 1 lekcja, 2 lekcje, 5 lekcji, 12 lekcji, 22 lekcje', () => {
    expect([0, 1, 2, 4, 5, 12, 14, 21, 22, 25, 112].map(lessonsLabel)).toEqual([
      '0 lekcji', '1 lekcja', '2 lekcje', '4 lekcje', '5 lekcji', '12 lekcji',
      '14 lekcji', '21 lekcji', '22 lekcje', '25 lekcji', '112 lekcji',
    ]);
  });

  it('saldo poniżej zera ma znak minus: −1 lekcja', () => {
    expect(lessonsLabel(-1)).toBe('−1 lekcja');
    expect(lessonsLabel(-3)).toBe('−3 lekcje');
  });

  it('godzina lekcji jest pokazana w strefie firmy, nie serwera', () => {
    const lesson = new Date('2027-01-11T15:00:00Z');
    expect(`${formatDay(lesson, 'Europe/Warsaw')}, ${formatTime(lesson, 'Europe/Warsaw')}`).toBe('poniedziałek, 11 stycznia, 16:00');
  });

  it('nagłówek tygodnia w kalendarzu: 9–15 listopada 2026, a na przełomie miesięcy i lat pełne daty', () => {
    expect(formatWeekRange('2026-11-09', '2026-11-15')).toBe('9–15 listopada 2026');
    expect(formatWeekRange('2026-11-30', '2026-12-06')).toBe('30 listopada – 6 grudnia 2026');
    expect(formatWeekRange('2026-12-28', '2027-01-03')).toBe('28 grudnia 2026 – 3 stycznia 2027');
  });

  it('termin odwołania po „do” ma datę bez dnia tygodnia: do 11 stycznia', () => {
    expect(formatDate(new Date('2027-01-11T15:00:00Z'), 'Europe/Warsaw')).toBe('11 stycznia');
    // Dzień w strefie firmy: 23:30 UTC 10 stycznia to już 11 stycznia w Warszawie.
    expect(formatDate(new Date('2027-01-10T23:30:00Z'), 'Europe/Warsaw')).toBe('11 stycznia');
  });
});
