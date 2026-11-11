import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listMyFirms, ROLE_LABELS } from '../../../lib/firms';
import { server } from '../../../lib/server';
import { requireUser } from '../../../lib/session';
import { LogoutButton } from '../logout-button';

export default async function FirmPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const firms = await listMyFirms(server().db, user.id);
  const firm = firms.find((candidate) => candidate.slug === slug);
  if (!firm) notFound();

  return (
    <main className="card">
      {firms.length > 1 ? (
        <p>
          <Link href="/panel">← Twoje firmy</Link>
        </p>
      ) : null}
      <h1>{firm.name}</h1>
      <p>
        Twoja rola: <strong>{firm.roles.map((role) => ROLE_LABELS[role]).join(', ')}</strong>
      </p>
      <p className="muted">Tu pojawią się grafik i rezerwacje (etap 3).</p>
      <p className="muted">Zalogowano jako {user.email}.</p>
      <LogoutButton />
    </main>
  );
}
