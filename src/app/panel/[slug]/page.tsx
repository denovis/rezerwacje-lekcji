import Link from 'next/link';
import { ROLE_LABELS } from '../../../lib/firms';
import { server } from '../../../lib/server';
import { requireFirm, requireUser } from '../../../lib/session';
import { loadWeek } from '../../../lib/week';
import { LogoutButton } from '../logout-button';
import { WeekCalendar, type CalendarLinks } from './week-calendar';

export const metadata = { title: 'Kalendarz · Rezerwacje lekcji' };

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

export default async function FirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const query = await searchParams;
  const { firm, ctx, hasOtherFirms } = await requireFirm(user, slug);
  const week = await loadWeek(server().db, ctx, { week: single(query.tydzien), serviceId: single(query.usluga) });
  const view = single(query.widok) === 'lista' ? 'list' : 'calendar';

  // Adres strony z wybranym tygodniem, widokiem i usługą (domyślne wartości pomijamy).
  const href = (changes: { tydzien?: string; widok?: 'calendar' | 'list'; usluga?: string }) => {
    const params = new URLSearchParams();
    const weekStart = changes.tydzien ?? week?.weekStart;
    if (weekStart && weekStart !== week?.currentWeek) params.set('tydzien', weekStart);
    if ((changes.widok ?? view) === 'list') params.set('widok', 'lista');
    const serviceId = changes.usluga ?? week?.service?.id;
    if (serviceId && serviceId !== week?.services[0]?.id) params.set('usluga', serviceId);
    const search = params.toString();
    return `/panel/${slug}${search ? `?${search}` : ''}`;
  };

  const links: CalendarLinks | null = week
    ? {
        previous: href({ tydzien: week.previousWeek }),
        next: href({ tydzien: week.nextWeek }),
        current: href({ tydzien: week.currentWeek }),
        calendar: href({ widok: 'calendar' }),
        list: href({ widok: 'list' }),
      }
    : null;

  return (
    <main className="card wide">
      <header className="panel-head">
        <div>
          {hasOtherFirms ? (
            <p className="small">
              <Link href="/panel">← Twoje firmy</Link>
            </p>
          ) : null}
          <h1>{firm.name}</h1>
          <p className="muted small">Twoja rola: {firm.roles.map((role) => ROLE_LABELS[role]).join(', ')}</p>
        </div>
        {week?.isStaff ? (
          <nav className="head-links" aria-label="Panel szkoły">
            <Link href={`/panel/${slug}/klienci`} className="pill">
              Klienci
            </Link>
            <Link href={`/panel/${slug}/ustawienia`} className="pill">
              Ustawienia grafiku
            </Link>
          </nav>
        ) : null}
        {week?.isInstructor ? (
          <div className="balance">
            <span className="muted small">Twoje lekcje</span>
            {week.upcoming ? (
              <span className="small">
                Najbliższa:{' '}
                <Link href={href({ tydzien: week.upcoming.nextWeek })} scroll={false}>
                  {week.upcoming.nextLabel}
                </Link>
              </span>
            ) : (
              <span className="muted small">Brak zaplanowanych lekcji</span>
            )}
          </div>
        ) : null}
        {week?.client ? (
          <div className="balance">
            <span className="muted small">Na koncie</span>
            <strong>{week.client.balanceLabel}</strong>
            {week.upcoming ? (
              <span className="small">
                Najbliższa lekcja:{' '}
                <Link href={href({ tydzien: week.upcoming.nextWeek })} scroll={false}>
                  {week.upcoming.nextLabel}
                </Link>
              </span>
            ) : (
              <span className="muted small">Brak zaplanowanych lekcji</span>
            )}
          </div>
        ) : null}
      </header>

      {week && week.services.length > 1 ? (
        <nav className="segmented services" aria-label="Rodzaj lekcji">
          {week.services.map((s) => (
            <Link
              key={s.id}
              href={href({ usluga: s.id })}
              scroll={false}
              aria-current={s.id === week.service?.id ? 'page' : undefined}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {week && links ? (
        <WeekCalendar data={week} slug={slug} view={view} links={links} />
      ) : (
        <p className="muted">
          Kalendarz widzą klienci, szkoła i instruktorzy. Jeśli prowadzisz lekcje, poproś szkołę o wpisanie Twojego adresu
          e-mail przy instruktorze w ustawieniach grafiku. Jeśli chcesz rezerwować lekcje, poproś szkołę o założenie profilu
          klienta.
        </p>
      )}

      <footer className="panel-foot">
        <span className="muted small">Zalogowano jako {user.email}.</span>
        <LogoutButton />
      </footer>
    </main>
  );
}
