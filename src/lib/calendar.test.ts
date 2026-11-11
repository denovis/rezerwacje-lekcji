// Co widzi klient, a co szkoła: lekcje, saldo i lista klientów.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCredits,
  appTestDatabaseUrl,
  createClient,
  createInstructor,
  createOrg,
  createPool,
  createService,
  createUser,
  insertBooking,
} from '../../db/tests/helpers.ts';
import { BookingError } from './bookings';
import { firmOverview, listBookings, listClients } from './calendar';
import { createDb, type Database } from './db';

let owner: pg.Pool;
let db: Database;
let orgId: string;
let ownerId: string;
let annaUser: string;
let anna: string;
let ewa: string;

beforeAll(async () => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
  orgId = await createOrg(owner, 'Szkoła Walca');
  ownerId = await createUser(owner);
  await owner.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, ownerId]);
  const instructorId = await createInstructor(owner, orgId, 'Ola');
  const serviceId = await createService(owner, orgId, 45);
  annaUser = await createUser(owner);
  anna = await createClient(owner, orgId, { userId: annaUser, status: 'regular' });
  ewa = await createClient(owner, orgId, { userId: await createUser(owner), status: 'regular' });
  await addCredits(owner, orgId, anna, 3, ownerId);
  for (const [clientId, start, end] of [
    [anna, '2027-04-05T16:00:00+02:00', '2027-04-05T16:45:00+02:00'],
    [ewa, '2027-04-05T17:00:00+02:00', '2027-04-05T17:45:00+02:00'],
  ] as const) {
    await insertBooking(owner, { orgId, instructorId, clientId, serviceId, start, end });
  }
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

const since = new Date('2027-04-01T00:00:00Z');

describe('Co widzi klient, a co szkoła', () => {
  it('klient widzi tylko swoje lekcje, także gdy poprosi o lekcje innej pary', async () => {
    const asAnna = { organizationId: orgId, userId: annaUser };
    const own = await listBookings(db, asAnna, { from: since });
    const asked = await listBookings(db, asAnna, { from: since, clientId: ewa });

    expect(own.map((b) => b.clientId)).toEqual([anna]);
    expect(asked.map((b) => b.clientId)).toEqual([anna]);
  });

  it('szkoła widzi lekcje wszystkich klientów', async () => {
    const all = await listBookings(db, { organizationId: orgId, userId: ownerId }, { from: since });
    expect(all.map((b) => b.clientId)).toEqual([anna, ewa]);
  });

  it('klient widzi swoje saldo lekcji', async () => {
    const overview = await firmOverview(db, { organizationId: orgId, userId: annaUser });
    expect(overview.isStaff).toBe(false);
    expect(overview.client).toMatchObject({ id: anna, status: 'regular', balance: 3 });
  });

  it('listę klientów z saldem widzi tylko szkoła', async () => {
    const clients = await listClients(db, { organizationId: orgId, userId: ownerId });
    expect(clients.map((c) => [c.id, c.balance])).toEqual(
      expect.arrayContaining([
        [anna, 3],
        [ewa, 0],
      ]),
    );
    await expect(listClients(db, { organizationId: orgId, userId: annaUser })).rejects.toBeInstanceOf(BookingError);
  });
});
