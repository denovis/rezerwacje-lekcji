import Link from 'next/link';
import { syncReturnedCheckout } from '../../../lib/checkout';
import { ROLE_LABELS } from '../../../lib/firms';
import type { CheckoutOutcome } from '../../../lib/payments';
import { server } from '../../../lib/server';
import { requireFirm, requireUser } from '../../../lib/session';
import { loadWeek } from '../../../lib/week';
import { LogoutButton } from '../logout-button';
import { BuyPackage } from './buy-package';
import type { Message } from './ui';
import { WeekCalendar, type CalendarLinks } from './week-calendar';

export const metadata = { title: 'Kalendarz · Rezerwacje lekcji' };

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

/** Komunikat po powrocie ze strony płatności Stripe (?platnosc=ok|przerwana). */
function paymentNotice(result: string | undefined, outcome: CheckoutOutcome | null): Message | null {
  if (result === 'przerwana') {
    return {
      kind: 'error',
      text: 'Płatność przerwana. Jeśli rezerwowaliście lekcję, termin czeka jeszcze chwilę: kliknijcie ją, żeby zapłacić albo zrezygnować.',
    };
  }
  if (result !== 'ok') return null;
  if (outcome === 'waiting') {
    return { kind: 'ok', text: 'Płatność jest w toku. Lekcje pojawią się na koncie, gdy bank ją potwierdzi.' };
  }
  if (outcome === 'late') {
    return { kind: 'ok', text: 'Dziękujemy za płatność! Termin zdążył już wrócić do puli, więc lekcja czeka na Waszym koncie.' };
  }
  return { kind: 'ok', text: 'Dziękujemy za płatność! Lekcje są już na Waszym koncie.' };
}

/** Komunikat po samodzielnym zapisie nowej pary (?zapisano=1). */
const SIGNED_UP: Message = {
  kind: 'ok',
  text: 'Gotowe, jesteście zapisani! Kliknijcie wolny termin w kalendarzu, żeby zarezerwować pierwszą lekcję.',
};

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
  const { db, payments } = server();

  // Powrót ze strony płatności: sprawdzamy sesję w Stripe, żeby lekcje trafiły na konto od razu.
  const paymentResult = single(query.platnosc);
  const sessionId = single(query.sesja);
  let outcome: CheckoutOutcome | null = null;
  if (paymentResult === 'ok' && sessionId && payments) {
    outcome = await syncReturnedCheckout(db, payments, firm.id, sessionId).catch((err: unknown) => {
      console.error('Nie udało się sprawdzić płatności po powrocie:', err);
      return null;
    });
  }

  const week = await loadWeek(db, ctx, {
    week: single(query.tydzien),
    serviceId: single(query.usluga),
    onlinePayments: payments !== null,
  });
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
              Ustawienia
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
            {week.onlinePackages.length > 0 ? <BuyPackage slug={slug} packages={week.onlinePackages} /> : null}
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
        <WeekCalendar
          data={week}
          slug={slug}
          view={view}
          links={links}
          notice={paymentNotice(paymentResult, outcome) ?? (single(query.zapisano) && week.client ? SIGNED_UP : null)}
        />
      ) : (
        <p className="muted">
          Kalendarz widzą klienci, szkoła i instruktorzy. Jeśli prowadzisz lekcje, poproś szkołę o wpisanie Twojego adresu
          e-mail przy instruktorze w ustawieniach. Jeśli chcesz rezerwować lekcje, poproś szkołę o założenie profilu
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
