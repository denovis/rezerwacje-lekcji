// Firmy, do których zalogowana osoba ma dostęp: jako właściciel, admin, instruktor albo klient.
import { withTenant, type Database } from './db';

export type FirmRole = 'owner' | 'admin' | 'instructor' | 'client';

export const ROLE_LABELS: Record<FirmRole, string> = {
  owner: 'właściciel',
  admin: 'administrator',
  instructor: 'instruktor',
  client: 'klient',
};

const ROLE_ORDER: FirmRole[] = ['owner', 'admin', 'instructor', 'client'];

export interface MyFirm {
  id: string;
  slug: string;
  name: string;
  roles: FirmRole[];
}

/**
 * Firmy zalogowanej osoby. Działa bez wybranej firmy: RLS pokazuje wtedy
 * tylko własne członkostwa i profile klienta.
 */
export function listMyFirms(db: Database, userId: string): Promise<MyFirm[]> {
  return withTenant(db, { organizationId: null, userId }, async (tx) => {
    const memberships = await tx
      .selectFrom('memberships as m')
      .innerJoin('organizations as o', 'o.id', 'm.organizationId')
      .select(['o.id', 'o.slug', 'o.name', 'm.role'])
      .where('m.userId', '=', userId)
      .execute();
    const clientProfiles = await tx
      .selectFrom('clients as c')
      .innerJoin('organizations as o', 'o.id', 'c.organizationId')
      .select(['o.id', 'o.slug', 'o.name'])
      .where('c.userId', '=', userId)
      .execute();

    const firms = new Map<string, MyFirm>();
    const add = (row: { id: string; slug: string; name: string }, role: FirmRole) => {
      const firm = firms.get(row.id) ?? { id: row.id, slug: row.slug, name: row.name, roles: [] };
      if (!firm.roles.includes(role)) firm.roles.push(role);
      firms.set(row.id, firm);
    };
    for (const row of memberships) add(row, row.role);
    for (const row of clientProfiles) add(row, 'client');

    return [...firms.values()]
      .map((firm) => ({ ...firm, roles: ROLE_ORDER.filter((role) => firm.roles.includes(role)) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  });
}

/** Firma o podanym adresie, jeśli zalogowana osoba ma w niej rolę albo profil klienta. */
export async function findMyFirm(db: Database, userId: string, slug: string): Promise<MyFirm | null> {
  const firms = await listMyFirms(db, userId);
  return firms.find((firm) => firm.slug === slug) ?? null;
}
