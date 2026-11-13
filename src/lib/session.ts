// Zalogowana osoba w stronach i akcjach serwera.
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { FirmContext } from './bookings';
import { listMyFirms, type MyFirm } from './firms';
import { server } from './server';

/** Zalogowana osoba albo null (strony dostępne także bez logowania, np. zapisy nowej pary). */
export async function currentUser(): Promise<{ id: string; email: string } | null> {
  // Najpierw nagłówki żądania: dzięki temu Next.js wie, że strona zależy od zalogowanej osoby
  // i nie próbuje budować jej z góry (wtedy nie ma jeszcze ustawień ani bazy).
  const requestHeaders = await headers();
  const session = await server().auth.api.getSession({ headers: requestHeaders });
  return session ? { id: session.user.id, email: session.user.email } : null;
}

/** Zwraca zalogowaną osobę albo przekierowuje na stronę logowania. */
export async function requireUser(): Promise<{ id: string; email: string }> {
  const user = await currentUser();
  if (!user) redirect('/logowanie');
  return user;
}

/**
 * Firma o podanym adresie, w której zalogowana osoba ma rolę albo profil klienta,
 * razem z kontekstem do zapytań (withTenant). Bez dostępu: strona 404.
 */
export async function requireFirm(
  user: { id: string },
  slug: string,
): Promise<{ firm: MyFirm; ctx: FirmContext; hasOtherFirms: boolean }> {
  const firms = await listMyFirms(server().db, user.id);
  const firm = firms.find((candidate) => candidate.slug === slug);
  if (!firm) notFound();
  return { firm, ctx: { organizationId: firm.id, userId: user.id }, hasOtherFirms: firms.length > 1 };
}
