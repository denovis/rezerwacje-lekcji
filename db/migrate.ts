// Uruchamia migracje SQL z db/migrations w kolejności nazw plików.
// Każdy plik w osobnej transakcji; zastosowane zapisuje w tabeli schema_migrations.
//
// Użycie: DATABASE_URL=postgres://... npm run db:migrate
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

export async function migrate(databaseUrl: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const appliedNow: string[] = [];
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedNow.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migracja ${file} nie powiodła się: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return appliedNow;
}

/** Zakłada bazę z adresu, jeśli jeszcze jej nie ma (np. Postgres uruchomiony przed dodaniem POSTGRES_DB). */
export async function ensureDatabase(databaseUrl: string): Promise<boolean> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) return false;
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
    return true;
  } finally {
    await admin.end();
  }
}

// Uruchomienie z linii poleceń.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Ustaw DATABASE_URL, np. postgres://postgres:postgres@localhost:5433/rezerwacje');
    process.exit(1);
  }
  ensureDatabase(url)
    .then((created) => {
      if (created) console.log('Założono bazę danych.');
      return migrate(url);
    })
    .then((applied) => console.log(applied.length ? `Zastosowano: ${applied.join(', ')}` : 'Baza jest aktualna.'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
