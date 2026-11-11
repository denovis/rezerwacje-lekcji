// Logowanie linkiem z maila: cały przepływ na prawdziwej bazie, bez przeglądarki.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appTestDatabaseUrl, createPool } from '../../db/tests/helpers.ts';
import { createAuth, MAGIC_LINK_MINUTES, type Auth } from './auth';
import { createDb, type Database } from './db';
import { magicLinkEmail } from './email';

let owner: pg.Pool;
let db: Database;
let auth: Auth;
const sent: { to: string; url: string }[] = [];

beforeAll(() => {
  owner = createPool();
  db = createDb(appTestDatabaseUrl());
  auth = createAuth({
    db,
    baseURL: 'http://localhost:3000',
    secret: 'sekret-testowy-co-najmniej-32-znaki-dlugi',
    sendMagicLink: async (to, url) => {
      sent.push({ to, url });
    },
  });
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

/** Prosi o link i zwraca token z maila. */
async function requestLink(email: string): Promise<string> {
  await auth.api.signInMagicLink({ body: { email, callbackURL: '/panel' }, headers: new Headers() });
  const last = sent.at(-1);
  expect(last?.to).toBe(email);
  const token = new URL(last!.url).searchParams.get('token');
  expect(token).toBeTruthy();
  return token!;
}

/** Klika link: zwraca adres przekierowania i ciasteczko sesji (jeśli powstało). */
async function openLink(token: string): Promise<{ location: string; cookie: string | null }> {
  const res = await auth.api.magicLinkVerify({
    query: { token, callbackURL: '/panel', errorCallbackURL: '/logowanie' },
    headers: new Headers(),
    asResponse: true,
  });
  const session = /better-auth\.session_token=[^;]+/.exec(res.headers.get('set-cookie') ?? '');
  return { location: res.headers.get('location') ?? '', cookie: session ? session[0] : null };
}

async function sessionUser(cookie: string) {
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  return session?.user ?? null;
}

describe('Logowanie linkiem z maila', () => {
  it('link z maila loguje i przy pierwszym logowaniu zakłada konto', async () => {
    const token = await requestLink('nowa.para@example.com');
    const { location, cookie } = await openLink(token);

    expect(location).toBe('http://localhost:3000/panel');
    expect(cookie).toBeTruthy();
    const user = await sessionUser(cookie!);
    expect(user?.email).toBe('nowa.para@example.com');
    const { rows } = await owner.query('SELECT email_verified FROM users WHERE email = $1', ['nowa.para@example.com']);
    expect(rows).toEqual([{ email_verified: true }]);
  });

  it('osoba dodana wcześniej przez szkołę loguje się do swojego konta, bez zakładania drugiego', async () => {
    const { rows } = await owner.query<{ id: string }>(
      "INSERT INTO users (email, name) VALUES ('ania.piotr@example.com', 'Ania i Piotr') RETURNING id",
    );
    const token = await requestLink('Ania.Piotr@example.com');
    const { cookie } = await openLink(token);

    const user = await sessionUser(cookie!);
    expect(user?.id).toBe(rows[0]!.id);
    const count = await owner.query("SELECT count(*)::int AS n FROM users WHERE email = 'ania.piotr@example.com'");
    expect(count.rows[0]?.n).toBe(1);
  });

  it('link z maila działa tylko raz', async () => {
    const token = await requestLink('raz@example.com');
    expect((await openLink(token)).cookie).toBeTruthy();

    const second = await openLink(token);
    expect(second.cookie).toBeNull();
    expect(second.location).toContain('/logowanie?error=');
  });

  it(`przeterminowany link nie loguje (link działa ${MAGIC_LINK_MINUTES} minut)`, async () => {
    const token = await requestLink('spozniony@example.com');
    await owner.query("UPDATE auth_verifications SET expires_at = now() - interval '1 minute'");

    const result = await openLink(token);
    expect(result.cookie).toBeNull();
    expect(result.location).toContain('/logowanie?error=');
  });

  it('token z linku nie jest zapisany w bazie wprost', async () => {
    const token = await requestLink('skrot@example.com');
    const { rows } = await owner.query<{ identifier: string; value: string }>(
      'SELECT identifier, value FROM auth_verifications',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.identifier).not.toContain(token);
      expect(row.value).not.toContain(token);
    }
  });

  it('wylogowanie kończy sesję', async () => {
    const { cookie } = await openLink(await requestLink('wyloguj@example.com'));
    expect(await sessionUser(cookie!)).not.toBeNull();

    await auth.api.signOut({ headers: new Headers({ cookie: cookie! }) });
    expect(await sessionUser(cookie!)).toBeNull();
  });

  it('mail z linkiem jest po polsku i mówi, jak długo link działa', () => {
    const email = magicLinkEmail('para@example.com', 'http://localhost:3000/api/auth/magic-link/verify?token=abc', 15);
    expect(email.subject).toBe('Link do logowania');
    expect(email.text).toContain('http://localhost:3000/api/auth/magic-link/verify?token=abc');
    expect(email.text).toContain('Link działa przez 15 minut i można go użyć tylko raz.');
  });
});
