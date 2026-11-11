import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadScheduleSetup } from '../../../../lib/schedule-setup';
import { server } from '../../../../lib/server';
import { requireFirm, requireUser } from '../../../../lib/session';
import { LogoutButton } from '../../logout-button';
import { SettingsView } from './settings-view';

export const metadata = { title: 'Ustawienia grafiku · Rezerwacje lekcji' };

/** Ustawienia grafiku szkoły: instruktorzy z godzinami pracy i wolnym, reguły grafiku i usługi (tylko dla szkoły). */
export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const { firm, ctx } = await requireFirm(user, slug);
  // Ustawienia zmienia tylko szkoła (właściciel, admin); pozostali wracają do kalendarza.
  if (!firm.roles.includes('owner') && !firm.roles.includes('admin')) redirect(`/panel/${slug}`);
  const setup = await loadScheduleSetup(server().db, ctx);

  return (
    <main className="card wide">
      <header className="panel-head">
        <div>
          <p className="small">
            <Link href={`/panel/${slug}`}>← Kalendarz</Link>
          </p>
          <h1>Ustawienia grafiku</h1>
          <p className="muted small">{firm.name}</p>
        </div>
      </header>

      <SettingsView setup={setup} slug={slug} />

      <footer className="panel-foot">
        <span className="muted small">Zalogowano jako {user.email}.</span>
        <LogoutButton />
      </footer>
    </main>
  );
}
