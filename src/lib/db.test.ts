// Dostęp aplikacji do bazy: logowanie rolą app_user i withTenant().
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appTestDatabaseUrl, createClient, createOrg, createPool } from '../../db/tests/helpers.ts';
import { createDb, withTenant, type Database } from './db';

let owner: pg.Pool;
let db: Database;
let singleConnection: Database;
let orgA: string;
let orgB: string;
let clientA: string;

beforeAll(async () => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
  singleConnection = createDb(appTestDatabaseUrl(), { max: 1 });
  orgA = await createOrg(owner, 'Szkoła A');
  orgB = await createOrg(owner, 'Szkoła B');
  clientA = await createClient(owner, orgA);
  await createClient(owner, orgB);
});

afterAll(async () => {
  await db.destroy();
  await singleConnection.destroy();
  await owner.end();
});

describe('Dostęp aplikacji do danych firm', () => {
  it('aplikacja łączy się z bazą rolą app_user', async () => {
    const { rows } = await sql<{ user: string }>`select current_user as "user"`.execute(db);
    expect(rows[0]?.user).toBe('app_user');
  });

  it('zapytanie bez withTenant nie widzi żadnych danych firm', async () => {
    const clients = await db.selectFrom('clients').select('id').execute();
    expect(clients).toEqual([]);
  });

  it('withTenant pokazuje tylko dane wybranej firmy', async () => {
    const clients = await withTenant(db, { organizationId: orgA, userId: null }, (tx) =>
      tx.selectFrom('clients').select(['id', 'organizationId']).execute(),
    );
    expect(clients).toEqual([{ id: clientA, organizationId: orgA }]);
  });

  it('wybrana firma nie przechodzi na kolejne zapytania z tego samego połączenia', async () => {
    await withTenant(singleConnection, { organizationId: orgA, userId: null }, (tx) =>
      tx.selectFrom('clients').select('id').execute(),
    );
    const after = await singleConnection.selectFrom('clients').select('id').execute();
    expect(after).toEqual([]);
  });

  it('błąd w środku withTenant wycofuje całą transakcję', async () => {
    const attempt = withTenant(db, { organizationId: orgA, userId: null }, async (tx) => {
      await tx.insertInto('clients').values({ organizationId: orgA, displayName: 'Para do wycofania' }).execute();
      throw new Error('coś poszło nie tak');
    });
    await expect(attempt).rejects.toThrow('coś poszło nie tak');
    const { rows } = await owner.query("SELECT count(*)::int AS n FROM clients WHERE display_name = 'Para do wycofania'");
    expect(rows[0]?.n).toBe(0);
  });
});
