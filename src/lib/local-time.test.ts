// Przeliczanie czasu lokalnego firmy na czas bezwzględny (ze zmianą czasu).
import { describe, expect, it } from 'vitest';
import { addDays, isLocalDate, isoWeekday, localDateOf, localTimeOf, localToInstant, timeToMinutes } from './local-time';

const TZ = 'Europe/Warsaw';
const iso = (instant: number) => new Date(instant).toISOString();

describe('Czas lokalny firmy', () => {
  it('16:00 w Warszawie to 15:00 UTC zimą i 14:00 UTC latem', () => {
    expect(iso(localToInstant('2027-01-11', 16 * 60, TZ))).toBe('2027-01-11T15:00:00.000Z');
    expect(iso(localToInstant('2027-07-12', 16 * 60, TZ))).toBe('2027-07-12T14:00:00.000Z');
  });

  it('w nocy zmiany czasu północ i godziny po zmianie przeliczają się poprawnie', () => {
    // 28.03.2027: o 2:00 zegary przesuwają się na 3:00. 31.10.2027: o 3:00 cofają się na 2:00.
    expect(iso(localToInstant('2027-03-28', 0, TZ))).toBe('2027-03-27T23:00:00.000Z');
    expect(iso(localToInstant('2027-03-28', 4 * 60, TZ))).toBe('2027-03-28T02:00:00.000Z');
    expect(iso(localToInstant('2027-10-31', 0, TZ))).toBe('2027-10-30T22:00:00.000Z');
    expect(iso(localToInstant('2027-10-31', 4 * 60, TZ))).toBe('2027-10-31T03:00:00.000Z');
  });

  it('godzina 24:00 to północ następnego dnia', () => {
    expect(localToInstant('2027-01-11', 24 * 60, TZ)).toBe(localToInstant('2027-01-12', 0, TZ));
  });

  it('lokalna data i godzina chwili zależą od strefy firmy', () => {
    const instant = Date.parse('2027-01-11T23:30:00Z');
    expect(localDateOf(instant, TZ)).toBe('2027-01-12');
    expect(localTimeOf(instant, TZ)).toBe('00:30');
    expect(localDateOf(instant, 'UTC')).toBe('2027-01-11');
  });

  it('dzień tygodnia liczymy według ISO: 1 = poniedziałek, 7 = niedziela', () => {
    expect(isoWeekday('2027-01-11')).toBe(1);
    expect(isoWeekday('2027-01-17')).toBe(7);
  });

  it('dodawanie dni działa przez koniec miesiąca, roku i zmianę czasu', () => {
    expect(addDays('2027-01-31', 1)).toBe('2027-02-01');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2027-03-27', 2)).toBe('2027-03-29');
    expect(addDays('2027-01-11', -11)).toBe('2026-12-31');
  });

  it('godziny z bazy i z formularza zamieniają się na minuty od północy', () => {
    expect(timeToMinutes('16:45:00')).toBe(16 * 60 + 45);
    expect(timeToMinutes('16:45')).toBe(16 * 60 + 45);
    expect(timeToMinutes('24:00:00')).toBe(24 * 60);
    expect(() => timeToMinutes('16:60')).toThrow();
    expect(() => timeToMinutes('1645')).toThrow();
  });

  it('data z formularza musi być prawdziwą datą RRRR-MM-DD', () => {
    expect(isLocalDate('2027-02-28')).toBe(true);
    expect(isLocalDate('2027-02-30')).toBe(false);
    expect(isLocalDate('28.02.2027')).toBe(false);
  });
});
