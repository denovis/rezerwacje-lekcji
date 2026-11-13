// Samodzielna rejestracja nowej pary na stronie zapisów szkoły: /zapisy/<adres szkoły> (etap 4c).
//
// Zasady (docs/decyzje.md, „Samodzielna rejestracja nowej pary”):
//  * Najpierw adres e-mail: para loguje się linkiem z maila, co potwierdza adres, i dopiero potem podaje dane.
//    Do tej chwili nic nie trafia do danych szkoły, więc nikt nie zapisze pary cudzym adresem.
//  * Profil dostaje adres, którym para się zalogowała, status „nowy” i limit 0: pierwszą lekcję opłaca online
//    (etap 4b) albo dostaje lekcje od szkoły (gotówka).
//  * Para podaje nazwę i telefon; data ślubu jest opcjonalna.
//  * Para, która ma już profil w szkole, nie zakłada drugiego. Osoba z rolą w szkole (właściciel, administrator,
//    instruktor) nie zapisuje się sama; profil klienta może jej założyć szkoła.
//  * Zapis trafia do dziennika (audit_log, 'client.registered').
import { actorOf, type FirmContext } from './bookings';
import { ClientError, cleanClient } from './clients';
import { withTenant, type Database } from './db';

/** Szkoła widoczna na stronie zapisów. */
export interface PublicFirm {
  id: string;
  slug: string;
  name: string;
}

/** Adres strony szkoły: małe litery, cyfry i myślniki (jak w bazie). */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Szkoła po adresie strony zapisów. Tabelę firm można czytać bez wybranej firmy i bez logowania. */
export async function findFirmBySlug(db: Database, slug: string): Promise<PublicFirm | null> {
  if (!SLUG.test(slug)) return null;
  const firm = await withTenant(db, { organizationId: null, userId: null }, (tx) =>
    tx.selectFrom('organizations').select(['id', 'slug', 'name']).where('slug', '=', slug).executeTakeFirst(),
  );
  return firm ?? null;
}

/**
 * Co zalogowana osoba widzi na stronie zapisów szkoły:
 *  * 'client' — ma już profil pary, więc idzie prosto do kalendarza,
 *  * 'member' — ma rolę w szkole i nie zapisuje się jako para,
 *  * 'open' — może się zapisać.
 */
export type SignUpState = 'client' | 'member' | 'open';

export function signUpState(db: Database, ctx: FirmContext): Promise<SignUpState> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    if (actor.ownClientId) return 'client';
    if (actor.role) return 'member';
    return 'open';
  });
}

export interface SignUpInput {
  /** Np. „Anna i Piotr”. */
  displayName: string;
  phone: string;
  /** Data ślubu (RRRR-MM-DD); pusta = brak. */
  targetDate?: string | null;
}

/**
 * Zakłada profil nowej pary dla zalogowanej osoby (ctx.userId) w szkole ctx.organizationId.
 * Para, która ma już profil, dostaje ten sam (created: false), więc podwójne kliknięcie nic nie psuje.
 */
export function registerClient(
  db: Database,
  ctx: FirmContext,
  input: SignUpInput,
): Promise<{ id: string; created: boolean }> {
  return withTenant(db, ctx, async (tx) => {
    const actor = await actorOf(tx, ctx);
    if (actor.ownClientId) return { id: actor.ownClientId, created: false };
    if (actor.role) throw new ClientError('signup_member');

    const fields = cleanClient({ displayName: input.displayName, phone: input.phone, targetDate: input.targetDate });
    if (!fields.phone) throw new ClientError('phone_required');

    // Adres z konta, którym para się zalogowała (link z maila go potwierdził), nie z formularza.
    const user = await tx.selectFrom('users').select('email').where('id', '=', ctx.userId).executeTakeFirst();
    if (!user) throw new Error('Nie znaleziono konta zalogowanej osoby.');
    const sameEmail = await tx
      .selectFrom('clients')
      .select('id')
      .where('organizationId', '=', ctx.organizationId)
      .where('email', '=', user.email)
      .executeTakeFirst();
    if (sameEmail) throw new ClientError('signup_email_taken');

    // Dwa zapisy tej samej osoby w tej samej chwili: drugi trafia na unikalny indeks i nic nie wstawia.
    const inserted = await tx
      .insertInto('clients')
      .values({
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        displayName: fields.displayName,
        email: user.email,
        phone: fields.phone,
        targetDate: fields.targetDate,
        status: 'new',
        creditLimit: 0,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const own = await actorOf(tx, ctx);
      if (own.ownClientId) return { id: own.ownClientId, created: false };
      throw new ClientError('signup_email_taken');
    }

    await tx
      .insertInto('auditLog')
      .values({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'client.registered',
        entity: 'clients',
        entityId: inserted.id,
        data: JSON.stringify({
          displayName: fields.displayName,
          email: user.email,
          phone: fields.phone,
          targetDate: fields.targetDate,
        }),
      })
      .execute();
    return { id: inserted.id, created: true };
  });
}
