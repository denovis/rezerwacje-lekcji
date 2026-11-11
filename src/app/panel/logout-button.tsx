import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { server } from '../../lib/server';

async function logout() {
  'use server';
  await server().auth.api.signOut({ headers: await headers() });
  redirect('/logowanie');
}

export function LogoutButton() {
  return (
    <form action={logout} className="actions">
      <button type="submit" className="secondary">
        Wyloguj
      </button>
    </form>
  );
}
