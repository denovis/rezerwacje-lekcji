// Dane startowe do pracy lokalnej (npm run db:seed).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_CLIENT, DEV_SCHOOL, seedDev } from '../seed-dev.ts';
import { createPool, testDatabaseUrl } from './helpers.ts';

let pool: pg.Pool;

beforeAll(() => {
  pool = createPool();
});

afterAll(async () => {
  await pool.end();
});

describe('Dane startowe', () => {
  it('dane startowe tworzą szkołę z właścicielem i usługą 45 minut, a powtórne uruchomienie niczego nie dubluje', async () => {
    const first = await seedDev(testDatabaseUrl(), 'wlasciciel@example.com');
    const second = await seedDev(testDatabaseUrl(), 'wlasciciel@example.com');
    expect(second).toEqual(first);

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM organizations WHERE slug = $1) AS schools,
         (SELECT count(*)::int FROM memberships WHERE organization_id = $2 AND user_id = $3 AND role = 'owner') AS owners,
         (SELECT count(*)::int FROM organization_settings WHERE organization_id = $2) AS settings,
         (SELECT array_agg(duration_minutes) FROM services WHERE organization_id = $2) AS services`,
      [DEV_SCHOOL.slug, first.organizationId, first.userId],
    );
    expect(rows[0]).toEqual({ schools: 1, owners: 1, settings: 1, services: [45] });
  });

  it('dane startowe dodają instruktora z godzinami pracy pon–pt 16:00–21:00 i parę z lekcjami na koncie, bez dublowania', async () => {
    const first = await seedDev(testDatabaseUrl(), 'wlasciciel@example.com', 'para.startowa@example.com');
    const second = await seedDev(testDatabaseUrl(), 'wlasciciel@example.com', 'para.startowa@example.com');
    expect(second).toEqual(first);

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM instructors WHERE organization_id = $1) AS instructors,
         (SELECT array_agg(weekday ORDER BY weekday) FROM availability_rules WHERE instructor_id = $2) AS weekdays,
         (SELECT array_agg(DISTINCT start_time::text || '–' || end_time::text) FROM availability_rules WHERE instructor_id = $2) AS hours,
         (SELECT balance FROM client_balances WHERE client_id = $3) AS balance,
         (SELECT u.email::text FROM clients c JOIN users u ON u.id = c.user_id WHERE c.id = $3) AS client_email`,
      [first.organizationId, first.instructorId, first.clientId],
    );
    expect(rows[0]).toEqual({
      instructors: 1,
      weekdays: DEV_SCHOOL.weekdays,
      hours: ['16:00:00–21:00:00'],
      balance: DEV_CLIENT.credits,
      client_email: 'para.startowa@example.com',
    });
  });
});
