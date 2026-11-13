// Strona zapisów nowej pary: /zapisy/<adres szkoły>. Link do niej szkoła ma na stronie Klienci.
// Bez logowania: adres e-mail i link z maila (potwierdza adres i zakłada konto).
// Po kliknięciu linku para wraca tutaj i podaje dane; potem trafia do kalendarza (src/lib/registration.ts).
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MAGIC_LINK_MINUTES } from '../../../lib/auth';
import { findFirmBySlug, signUpState } from '../../../lib/registration';
import { server } from '../../../lib/server';
import { currentUser } from '../../../lib/session';
import { LoginForm } from '../../logowanie/login-form';
import { LogoutButton } from '../../panel/logout-button';
import { SignUpForm } from './signup-form';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const firm = await findFirmBySlug(server().db, (await params).slug);
  return { title: `Zapisy${firm ? ` · ${firm.name}` : ''} · Rezerwacje lekcji` };
}

export default async function SignUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const { error } = await searchParams;
  const firm = await findFirmBySlug(server().db, slug);
  if (!firm) notFound();
  const here = `/zapisy/${firm.slug}`;
  const user = await currentUser();

  if (!user) {
    return (
      <main className="card">
        <p className="muted small">{firm.name}</p>
        <h1>Zapisy na lekcje</h1>
        <p className="muted">
          Podajcie adres e-mail. Wyślemy na niego link, który potwierdzi adres. Potem podacie dane pary i od razu wybierzecie
          termin pierwszej lekcji.
        </p>
        {error ? (
          <p className="alert" role="alert">
            Ten link wygasł albo został już użyty. Wyślijcie nowy.
          </p>
        ) : null}
        <LoginForm
          minutes={MAGIC_LINK_MINUTES}
          callbackURL={here}
          errorCallbackURL={here}
          submitLabel="Wyślij link"
          afterSent="Po kliknięciu wrócicie na tę stronę i podacie dane pary."
        />
        <p className="muted small signup-note">Jesteście już zapisani? Ten sam link Was zaloguje.</p>
      </main>
    );
  }

  const state = await signUpState(server().db, { organizationId: firm.id, userId: user.id });
  if (state === 'client') redirect(`/panel/${firm.slug}`);

  if (state === 'member') {
    return (
      <main className="card">
        <p className="muted small">{firm.name}</p>
        <h1>Zapisy na lekcje</h1>
        <p>
          Masz już rolę w tej szkole, więc nie zapisujesz się jako para. To strona dla nowych par: wyślij im jej adres.
        </p>
        <p className="muted small">Żeby sprawdzić zapis, wyloguj się i podaj inny adres e-mail.</p>
        <p>
          <Link href={`/panel/${firm.slug}`}>Przejdź do kalendarza</Link>
        </p>
        <LogoutButton redirectTo={here} />
      </main>
    );
  }

  return (
    <main className="card">
      <p className="muted small">{firm.name}</p>
      <h1>Zapisy na lekcje</h1>
      <p className="muted">
        Adres e-mail: <strong>{user.email}</strong>. Tym adresem będziecie się logować.
      </p>
      <SignUpForm slug={firm.slug} />
      <div className="panel-foot">
        <span className="muted small">To nie Wasz adres?</span>
        <LogoutButton redirectTo={here} />
      </div>
    </main>
  );
}
