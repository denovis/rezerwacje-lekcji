// Reguły rezerwacji pilnowane przez samą bazę danych.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  insertBooking,
  pgErrorCode,
} from './helpers.ts';

let pool: pg.Pool;
let orgId: string;
let instructorId: string;
let otherInstructorId: string;
let clientId: string;
let serviceId: string;

// Każdy test dostaje osobny dzień, żeby testy nie blokowały się nawzajem.
let dayCounter = 0;
const nextDay = () => `2027-01-${String(++dayCounter).padStart(2, '0')}`;
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00+01:00`;

beforeAll(async () => {
  pool = createPool();
  orgId = await createOrg(pool);
  instructorId = await createInstructor(pool, orgId, 'Ola');
  otherInstructorId = await createInstructor(pool, orgId, 'Kuba');
  clientId = await createClient(pool, orgId, { status: 'regular' });
  serviceId = await createService(pool, orgId);
});

afterAll(async () => {
  await pool.end();
});

const lesson = (day: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  orgId,
  instructorId,
  clientId,
  serviceId,
  start: at(day, from),
  end: at(day, to),
  ...extra,
});

describe('Rezerwacje: nakładające się terminy', () => {
  it('ten sam instruktor nie może mieć dwóch nakładających się lekcji', async () => {
    const d = nextDay();
    await insertBooking(pool, lesson(d, '16:00', '17:00'));
    expect(await pgErrorCode(insertBooking(pool, lesson(d, '16:30', '17:30')))).toBe('23P01');
  });

  it('lekcje stykające się (16:00–17:00 i 17:00–18:00) są dozwolone', async () => {
    const d = nextDay();
    await insertBooking(pool, lesson(d, '16:00', '17:00'));
    await expect(insertBooking(pool, lesson(d, '17:00', '18:00'))).resolves.toBeTruthy();
  });

  it('przerwa po lekcji blokuje kalendarz: przy 10 min przerwy następna lekcja zaczyna się najwcześniej 17:10', async () => {
    const d = nextDay();
    await insertBooking(pool, lesson(d, '16:00', '17:00', { blocksUntil: at(d, '17:10') }));
    expect(await pgErrorCode(insertBooking(pool, lesson(d, '17:00', '18:00')))).toBe('23P01');
    await expect(insertBooking(pool, lesson(d, '17:10', '18:10'))).resolves.toBeTruthy();
  });

  it('dwóch różnych instruktorów może mieć lekcje o tej samej godzinie', async () => {
    const d = nextDay();
    await insertBooking(pool, lesson(d, '16:00', '17:00'));
    await expect(
      insertBooking(pool, lesson(d, '16:00', '17:00', { instructorId: otherInstructorId })),
    ).resolves.toBeTruthy();
  });

  it.each(['cancelled', 'late_cancelled', 'expired'])(
    'rezerwacja o statusie %s nie blokuje terminu',
    async (status) => {
      const d = nextDay();
      await insertBooking(pool, lesson(d, '16:00', '17:00', { status }));
      await expect(insertBooking(pool, lesson(d, '16:00', '17:00'))).resolves.toBeTruthy();
    },
  );

  it('rezerwacja czekająca na płatność blokuje termin', async () => {
    const d = nextDay();
    await insertBooking(pool, lesson(d, '16:00', '17:00', { status: 'pending_payment' }));
    expect(await pgErrorCode(insertBooking(pool, lesson(d, '16:00', '17:00')))).toBe('23P01');
  });

  it('rezerwacja czekająca na płatność musi mieć czas wygaśnięcia blokady', async () => {
    const d = nextDay();
    expect(
      await pgErrorCode(insertBooking(pool, lesson(d, '16:00', '17:00', { status: 'pending_payment', holdExpiresAt: null }))),
    ).toBe('23514');
  });

  it('dwie osoby klikające ten sam termin w tej samej chwili: przechodzi tylko jedna', async () => {
    const d = nextDay();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await insertBooking(first, lesson(d, '16:00', '17:00'));
      // Druga transakcja czeka, aż pierwsza się skończy, i dopiero wtedy dostaje odmowę.
      const secondAttempt = pgErrorCode(insertBooking(second, lesson(d, '16:00', '17:00')));
      await new Promise((r) => setTimeout(r, 300));
      await first.query('COMMIT');
      expect(await secondAttempt).toBe('23P01');
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM bookings WHERE instructor_id = $1 AND starts_at = $2',
      [instructorId, at(d, '16:00')],
    );
    expect(rows[0]?.n).toBe(1);
  });
});
