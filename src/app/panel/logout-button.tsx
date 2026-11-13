import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { server } from '../../lib/server';

/** Wylogowanie; potem strona logowania albo inna strona podana przez serwer (np. zapisy nowej pary). */
export function LogoutButton({ redirectTo = '/logowanie' }: { redirectTo?: string }) {
  async function logout() {
    'use server';
    await server().auth.api.signOut({ headers: await headers() });
    redirect(redirectTo);
  }

  return (
    <form action={logout} className="actions">
      <button type="submit" className="secondary">
        Wyloguj
      </button>
    </form>
  );
}
