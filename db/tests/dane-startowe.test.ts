// Dane startowe do pracy lokalnej (npm run db:seed).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_SCHOOL, seedDev } from '../seed-dev.ts';
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
});
