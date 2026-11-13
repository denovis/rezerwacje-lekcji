import Link from 'next/link';
import { redirect } from 'next/navigation';
import { clientsInDebt, loadClients } from '../../../../lib/clients';
import { server } from '../../../../lib/server';
import { requireFirm, requireUser } from '../../../../lib/session';
import { LogoutButton } from '../../logout-button';
import { ClientsView } from './clients-view';

export const metadata = { title: 'Klienci · Rezerwacje lekcji' };

/** Klienci szkoły: lista par z saldem, osoby na minusie, historia lekcji i korekta salda (tylko dla szkoły). */
export default async function ClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const query = await searchParams;
  const { firm, ctx } = await requireFirm(user, slug);
  // Klientów prowadzi tylko szkoła (właściciel, admin); pozostali wracają do kalendarza.
  if (!firm.roles.includes('owner') && !firm.roles.includes('admin')) redirect(`/panel/${slug}`);
  const overview = await loadClients(server().db, ctx);
  const open = typeof query.para === 'string' && overview.clients.some((c) => c.id === query.para) ? query.para : null;

  return (
    <main className="card wide">
      <header className="panel-head">
        <div>
          <p className="small">
            <Link href={`/panel/${slug}`}>← Kalendarz</Link>
          </p>
          <h1>Klienci</h1>
          <p className="muted small">{firm.name}</p>
        </div>
      </header>

      <ClientsView
        overview={overview}
        debtorIds={clientsInDebt(overview.clients).map((c) => c.id)}
        slug={slug}
        openClientId={open}
        signUpUrl={new URL(`/zapisy/${slug}`, server().baseUrl).toString()}
      />

      <footer className="panel-foot">
        <span className="muted small">Zalogowano jako {user.email}.</span>
        <LogoutButton />
      </footer>
    </main>
  );
}
