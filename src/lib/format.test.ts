// Teksty w interfejsie po polsku.
import { describe, expect, it } from 'vitest';
import {
  describeWeeklyHours,
  formatDate,
  formatDay,
  formatLocalDay,
  formatMoney,
  formatMoneyInput,
  formatTime,
  formatWeekRange,
  lessonsLabel,
  parseMoney,
} from './format';

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

  it('godziny pracy w ustawieniach: dni z tymi samymi godzinami są w jednym wierszu, np. pon.–pt. 16:00–21:00', () => {
    const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '16:00', end: '21:00' }));
    expect(describeWeeklyHours(weekdays)).toEqual(['pon.–pt. 16:00–21:00']);
    expect(
      describeWeeklyHours([
        ...weekdays.filter((r) => r.weekday !== 3),
        { weekday: 6, start: '13:00', end: '15:00' },
        { weekday: 6, start: '10:00', end: '12:00' },
      ]),
    ).toEqual(['pon.–wt., czw.–pt. 16:00–21:00', 'sob. 10:00–12:00, 13:00–15:00']);
    expect(
      describeWeeklyHours([
        { weekday: 3, start: '16:00', end: '21:00' },
        { weekday: 1, start: '16:00', end: '21:00' },
      ]),
    ).toEqual(['pon., śr. 16:00–21:00']);
    expect(describeWeeklyHours([])).toEqual([]);
  });

  it('kwoty są po polsku: 900,00 zł, 1200,50 zł i 12 345,00 zł', () => {
    const plain = (text: string) => text.replace(/\s/g, ' ');
    expect(plain(formatMoney(90000))).toBe('900,00 zł');
    expect(plain(formatMoney(120050))).toBe('1200,50 zł');
    expect(plain(formatMoney(1234500))).toBe('12 345,00 zł');
  });

  it('kwota wpisana w złotych: 180, 180,5, 180.50 i 1 200 to grosze; reszta nie jest kwotą', () => {
    expect(['180', '180,5', '180.50', '1 200', '0', '900 zł'].map(parseMoney)).toEqual([18000, 18050, 18050, 120000, 0, 90000]);
    expect(['', 'abc', '-5', '1,234', '12,3,4'].map(parseMoney)).toEqual([null, null, null, null, null]);
    // Pole formularza pokazuje kwotę tak, żeby po wczytaniu wyszła ta sama liczba groszy.
    expect([90000, 18050, 5].map(formatMoneyInput)).toEqual(['900', '180,50', '0,05']);
    expect([90000, 18050, 5].map((cents) => parseMoney(formatMoneyInput(cents)))).toEqual([90000, 18050, 5]);
  });

  it('dzień w ustawieniach ma krótką nazwę dnia tygodnia: pon., 11 stycznia', () => {
    expect(formatLocalDay('2027-01-11')).toBe('pon., 11 stycznia');
  });

  it('termin odwołania po „do” ma datę bez dnia tygodnia: do 11 stycznia', () => {
    expect(formatDate(new Date('2027-01-11T15:00:00Z'), 'Europe/Warsaw')).toBe('11 stycznia');
    // Dzień w strefie firmy: 23:30 UTC 10 stycznia to już 11 stycznia w Warszawie.
    expect(formatDate(new Date('2027-01-10T23:30:00Z'), 'Europe/Warsaw')).toBe('11 stycznia');
  });
});
