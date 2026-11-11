// Przed testami: tworzy od zera bazę testową, stosuje wszystkie migracje
// i pozwala logować się rolą app_user (tak jak robi to aplikacja).
import pg from 'pg';
import { enableAppLogin } from '../app-login.ts';
import { migrate } from '../migrate.ts';
import { ADMIN_URL, TEST_DB, appTestDatabaseUrl, testDatabaseUrl } from './helpers.ts';

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
  await enableAppLogin(testDatabaseUrl(), appTestDatabaseUrl());
}
