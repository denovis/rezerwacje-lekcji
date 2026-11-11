// Układ kalendarza tygodniowego (czysta funkcja, bez bazy).
import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, gridRange, layoutDay } from './week-layout';

const block = (from: string, to: string) => {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return { name: `${from}–${to}`, start: minutes(from), end: minutes(to) };
};

describe('Kalendarz: układ bloków w dniu', () => {
  it('lekcje jedna po drugiej zajmują całą szerokość dnia', () => {
    const placed = layoutDay([block('16:45', '17:30'), block('16:00', '16:45')]);
    expect(placed.map((p) => [p.item.name, p.column, p.columns])).toEqual([
      ['16:00–16:45', 0, 1],
      ['16:45–17:30', 0, 1],
    ]);
  });

  it('nachodzące na siebie bloki (np. dwóch instruktorów o tej samej godzinie) stoją obok siebie', () => {
    const placed = layoutDay([block('16:00', '16:45'), block('16:30', '17:15'), block('18:00', '18:45')]);
    expect(placed.map((p) => [p.item.name, p.column, p.columns])).toEqual([
      ['16:00–16:45', 0, 2],
      ['16:30–17:15', 1, 2],
      ['18:00–18:45', 0, 1],
    ]);
  });

  it('wolna kolumna w grupie jest używana ponownie', () => {
    const placed = layoutDay([block('16:00', '17:00'), block('16:00', '16:30'), block('16:30', '17:00')]);
    expect(placed.map((p) => [p.item.name, p.column, p.columns])).toEqual([
      ['16:00–17:00', 0, 2],
      ['16:00–16:30', 1, 2],
      ['16:30–17:00', 1, 2],
    ]);
  });
});

describe('Kalendarz: zakres godzin siatki', () => {
  it('zakres obejmuje godziny pracy i lekcje wpisane poza nimi, zaokrąglony do pełnych godzin', () => {
    const hours = (h1: number, h2: number) => ({ start: h1 * 60, end: h2 * 60 });
    expect(gridRange(block('16:00', '21:00'), [])).toEqual(hours(16, 21));
    expect(gridRange(block('16:00', '21:00'), [block('12:15', '13:00')])).toEqual(hours(12, 21));
    expect(gridRange(block('16:00', '20:30'), [])).toEqual(hours(16, 21));
  });

  it('bez godzin pracy i lekcji kalendarz pokazuje 8:00–20:00', () => {
    expect(gridRange(null, [])).toEqual(DEFAULT_RANGE);
  });
});
