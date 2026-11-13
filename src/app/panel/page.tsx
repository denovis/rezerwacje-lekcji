import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listMyFirms, ROLE_LABELS } from '../../lib/firms';
import { server } from '../../lib/server';
import { requireUser } from '../../lib/session';
import { LogoutButton } from './logout-button';

export const metadata = { title: 'Twoje firmy · Rezerwacje lekcji' };

export default async function PanelPage() {
  const user = await requireUser();
  const firms = await listMyFirms(server().db, user.id);
  const only = firms.length === 1 ? firms[0] : undefined;
  if (only) redirect(`/panel/${only.slug}`);

  return (
    <main className="card">
      <h1>Twoje firmy</h1>
      <p className="muted">Zalogowano jako {user.email}.</p>
      {firms.length === 0 ? (
        <>
          <p>Nie masz jeszcze dostępu do żadnej firmy.</p>
          <p className="muted small">Chcecie zapisać się na lekcje? Poproście szkołę o link do zapisów.</p>
        </>
      ) : (
        <ul className="firms">
          {firms.map((firm) => (
            <li key={firm.id}>
              <Link href={`/panel/${firm.slug}`}>{firm.name}</Link>
              <span className="muted"> · {firm.roles.map((role) => ROLE_LABELS[role]).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      <LogoutButton />
    </main>
  );
}
