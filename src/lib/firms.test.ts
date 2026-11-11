// Lista firm zalogowanej osoby (po zalogowaniu, przed wyborem firmy).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appTestDatabaseUrl, createClient, createOrg, createPool, createUser } from '../../db/tests/helpers.ts';
import { createDb, type Database } from './db';
import { findMyFirm, listMyFirms } from './firms';

let owner: pg.Pool;
let db: Database;

beforeAll(() => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

async function slugOf(orgId: string): Promise<string> {
  const { rows } = await owner.query<{ slug: string }>('SELECT slug FROM organizations WHERE id = $1', [orgId]);
  return rows[0]!.slug;
}

describe('Firmy zalogowanej osoby', () => {
  it('lista zawiera firmy, w których osoba ma rolę albo profil klienta, z rolami', async () => {
    const userId = await createUser(owner);
    const school = await createOrg(owner, 'Akademia Walca');
    const gym = await createOrg(owner, 'Bachata Studio');
    await createOrg(owner, 'Obca szkoła');
    await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [school, userId]);
    await createClient(owner, school, { userId });
    await createClient(owner, gym, { userId });

    const firms = await listMyFirms(db, userId);

    expect(firms).toEqual([
      { id: school, slug: await slugOf(school), name: 'Akademia Walca', roles: ['owner', 'client'] },
      { id: gym, slug: await slugOf(gym), name: 'Bachata Studio', roles: ['client'] },
    ]);
  });

  it('osoba bez roli i bez profilu klienta nie widzi żadnej firmy', async () => {
    const userId = await createUser(owner);
    await createOrg(owner, 'Szkoła, do której nie należy');
    expect(await listMyFirms(db, userId)).toEqual([]);
  });

  it('firmy po adresie nie da się otworzyć bez roli w niej', async () => {
    const userId = await createUser(owner);
    const stranger = await createOrg(owner, 'Cudza szkoła');
    expect(await findMyFirm(db, userId, await slugOf(stranger))).toBeNull();
  });
});
