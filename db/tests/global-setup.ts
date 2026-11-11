// Przed testami: tworzy od zera bazę testową i stosuje wszystkie migracje.
import pg from 'pg';
import { migrate } from '../migrate.ts';
import { ADMIN_URL, TEST_DB, testDatabaseUrl } from './helpers.ts';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  await migrate(testDatabaseUrl());
}
