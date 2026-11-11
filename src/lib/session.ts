// Zalogowana osoba w stronach i akcjach serwera.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { server } from './server';

/** Zwraca zalogowaną osobę albo przekierowuje na stronę logowania. */
export async function requireUser(): Promise<{ id: string; email: string }> {
  // Najpierw nagłówki żądania: dzięki temu Next.js wie, że strona zależy od zalogowanej osoby
  // i nie próbuje budować jej z góry (wtedy nie ma jeszcze ustawień ani bazy).
  const requestHeaders = await headers();
  const session = await server().auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect('/logowanie');
  return { id: session.user.id, email: session.user.email };
}
