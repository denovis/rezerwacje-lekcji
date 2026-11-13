'use client';
// Strona Klienci: lista par z saldem i wyszukiwaniem, filtr „Na minusie” i okienko pary
// z historią lekcji, wpłatą gotówką, ręczną korektą salda oraz danymi i statusem.
// Wynik zmian pokazuje dymek na dole ekranu.
import { useEffect, useState } from 'react';
import type { ClientHistory, ClientSummary, ClientsOverview } from '../../../../lib/clients';
import type { ClientStatus } from '../../../../lib/db-types';
import { CLIENT_STATUS_LABELS, formatMoney, formatMoneyInput, lessonsLabel, parseMoney } from '../../../../lib/format';
import { adjustBalanceAction, cashPaymentAction, clientHistoryAction, saveClientAction, type CashPayload } from '../client-actions';
import { Modal, Toast, useAction, useToast } from '../ui';

type Filter = 'all' | 'debt';
type Tab = 'history' | 'cash' | 'adjust' | 'details';
type Dialog = { type: 'new' } | { type: 'client'; clientId: string };

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'history', label: 'Historia' },
  { tab: 'cash', label: 'Wpłata' },
  { tab: 'adjust', label: 'Korekta' },
  { tab: 'details', label: 'Dane' },
];

/** Cennik do formularza wpłaty: aktywne pakiety i cena pojedynczej lekcji. */
type Pricing = Pick<ClientsOverview, 'packages' | 'lessonPriceCents' | 'currency'>;

const STATUS_HINTS: Record<ClientStatus, string> = {
  new: 'Pierwszą lekcję rezerwuje z płatnością online albo z lekcjami na koncie.',
  regular: 'Rezerwuje, gdy ma lekcje na koncie.',
  trusted: 'Może zejść poniżej zera do swojego limitu i płacić na miejscu.',
};

/**
 * Kopiuje tekst do schowka. Niektóre przeglądarki (np. okna wbudowane w inne aplikacje) nie pozwalają
 * na navigator.clipboard; wtedy próbujemy starszym sposobem przez zaznaczone pole tekstowe.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

/** Saldo ze znakiem plus dla dopisanych lekcji, np. „+5 lekcji”, „−1 lekcja”. */
const signed = (delta: number) => `${delta > 0 ? '+' : ''}${lessonsLabel(delta)}`;

export function ClientsView({
  overview,
  debtorIds,
  slug,
  openClientId,
  signUpUrl,
}: {
  overview: ClientsOverview;
  debtorIds: string[];
  slug: string;
  openClientId: string | null;
  /** Strona, na której nowe pary zapisują się same (etap 4c). */
  signUpUrl: string;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(openClientId ? { type: 'client', clientId: openClientId } : null);
  const [message, setMessage] = useToast();

  const close = () => {
    setDialog(null);
    // Okienko otwarte z kalendarza (?para=…) nie otwiera się ponownie po odświeżeniu strony.
    if (window.location.search.includes('para=')) window.history.replaceState(null, '', window.location.pathname);
  };
  const done = (text: string) => {
    close();
    setMessage({ kind: 'ok', text });
  };

  const debtors = debtorIds.map((id) => overview.clients.find((c) => c.id === id)).filter((c): c is ClientSummary => !!c);
  const term = search.trim().toLowerCase();
  const shown = (filter === 'debt' ? debtors : overview.clients).filter(
    (c) => !term || [c.displayName, c.email ?? '', c.phone ?? ''].some((value) => value.toLowerCase().includes(term)),
  );
  const current = dialog?.type === 'client' ? overview.clients.find((c) => c.id === dialog.clientId) : undefined;

  const copySignUpUrl = async () => {
    const copied = await copyText(signUpUrl);
    setMessage(
      copied
        ? { kind: 'ok', text: 'Skopiowano link do zapisów. Wklejcie go parom, np. na stronę szkoły.' }
        : { kind: 'error', text: 'Nie udało się skopiować linku. Zaznacz go i skopiuj ręcznie.' },
    );
  };

  return (
    <>
      <Toast message={message} onHide={() => setMessage(null)} />

      <p className="small signup-link">
        <span className="muted">Nowe pary zapisują się same pod adresem: </span>
        <a href={signUpUrl} target="_blank" rel="noreferrer">
          {signUpUrl}
        </a>{' '}
        <button type="button" className="link-button accent" onClick={copySignUpUrl}>
          Kopiuj link
        </button>
      </p>

      <div className="clients-toolbar">
        <input
          type="search"
          className="search"
          placeholder="Szukaj: nazwa, e-mail, telefon"
          aria-label="Szukaj pary"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="segmented" role="tablist" aria-label="Które pary">
          <button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>
            Wszystkie ({overview.clients.length})
          </button>
          <button type="button" role="tab" aria-selected={filter === 'debt'} onClick={() => setFilter('debt')}>
            Na minusie ({debtors.length})
          </button>
        </div>
        <button type="button" onClick={() => setDialog({ type: 'new' })}>
          + Dodaj parę
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="muted">
          {overview.clients.length === 0
            ? 'Szkoła nie ma jeszcze klientów. Dodaj pierwszą parę.'
            : filter === 'debt' && !term
              ? 'Nikt nie jest na minusie.'
              : 'Nie znaleziono pary.'}
        </p>
      ) : (
        <ul className="row-list">
          {shown.map((client) => (
            <li key={client.id}>
              <button type="button" className="row-button client-row" onClick={() => setDialog({ type: 'client', clientId: client.id })}>
                <span>
                  <strong>{client.displayName}</strong>
                  <span className="muted small client-meta">
                    {CLIENT_STATUS_LABELS[client.status]}
                    {client.status === 'trusted' ? ` (limit −${client.creditLimit})` : ''}
                    {client.nextLesson ? ` · najbliższa lekcja: ${client.nextLesson}` : ''}
                    {client.hasAccount ? '' : ' · bez konta'}
                  </span>
                </span>
                <span className={`client-balance${client.balance < 0 ? ' negative' : ''}`}>{lessonsLabel(client.balance)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog?.type === 'new' ? (
        <NewClientDialog slug={slug} defaultLimit={overview.defaultTrustedCreditLimit} onClose={close} onDone={done} />
      ) : current ? (
        <ClientDialog
          key={current.id}
          client={current}
          slug={slug}
          defaultLimit={overview.defaultTrustedCreditLimit}
          pricing={overview}
          onClose={close}
          onDone={done}
        />
      ) : null}
    </>
  );
}

function NewClientDialog({
  slug,
  defaultLimit,
  onClose,
  onDone,
}: {
  slug: string;
  defaultLimit: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { pending, error, run } = useAction();
  return (
    <Modal onClose={onClose} pending={pending} error={error}>
      <h2>Nowa para</h2>
      <ClientForm
        client={null}
        defaultLimit={defaultLimit}
        pending={pending}
        onSave={(payload) =>
          run(
            () => saveClientAction({ slug, ...payload }),
            () =>
              onDone(
                payload.email
                  ? `Dodano parę: ${payload.displayName.trim()}. Może się zalogować adresem ${payload.email.trim()}.`
                  : `Dodano parę: ${payload.displayName.trim()}.`,
              ),
          )
        }
      />
    </Modal>
  );
}

function ClientDialog({
  client,
  slug,
  defaultLimit,
  pricing,
  onClose,
  onDone,
}: {
  client: ClientSummary;
  slug: string;
  defaultLimit: number;
  pricing: Pricing;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { pending, error, run } = useAction();
  const [tab, setTab] = useState<Tab>('history');

  return (
    <Modal onClose={onClose} pending={pending} error={error}>
      <h2>{client.displayName}</h2>
      <p className="muted small">
        {CLIENT_STATUS_LABELS[client.status]} · na koncie{' '}
        <strong className={client.balance < 0 ? 'negative' : ''}>{lessonsLabel(client.balance)}</strong>
        {client.email ? ` · ${client.email}` : ''}
        {client.phone ? ` · ${client.phone}` : ''}
      </p>
      <div className="segmented dialog-kinds" role="tablist" aria-label="Para">
        {TABS.map(({ tab: value, label }) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} disabled={pending}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'history' ? (
        <HistoryList slug={slug} clientId={client.id} />
      ) : tab === 'cash' ? (
        <CashForm
          balance={client.balance}
          pricing={pricing}
          pending={pending}
          onSave={(payload, summary) =>
            run(
              () => cashPaymentAction({ slug, clientId: client.id, ...payload }),
              (result) =>
                onDone(`Przyjęto gotówkę: ${client.displayName}, ${summary}. Na koncie: ${lessonsLabel(result.balance ?? 0)}.`),
            )
          }
        />
      ) : tab === 'adjust' ? (
        <AdjustForm
          balance={client.balance}
          pending={pending}
          onSave={(delta, note) =>
            run(
              () => adjustBalanceAction({ slug, clientId: client.id, delta, note }),
              (result) =>
                onDone(`Zapisano korektę: ${client.displayName}, ${signed(delta)}. Na koncie: ${lessonsLabel(result.balance ?? 0)}.`),
            )
          }
        />
      ) : (
        <ClientForm
          client={client}
          defaultLimit={defaultLimit}
          pending={pending}
          onSave={(payload) =>
            run(() => saveClientAction({ slug, clientId: client.id, ...payload }), () => onDone(`Zapisano: ${payload.displayName.trim()}.`))
          }
        />
      )}
    </Modal>
  );
}

function HistoryList({ slug, clientId }: { slug: string; clientId: string }) {
  const [history, setHistory] = useState<ClientHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    clientHistoryAction({ slug, clientId }).then((result) => {
      if (!active) return;
      if (result.ok) setHistory(result.history);
      else setError(result.error);
    });
    return () => {
      active = false;
    };
  }, [slug, clientId]);

  if (error) return <p className="alert">{error}</p>;
  if (!history) return <p className="muted history-loading">Wczytuję historię…</p>;
  if (history.entries.length === 0) return <p className="muted">Brak wpisów: para nie miała jeszcze lekcji ani wpłat.</p>;

  return (
    <ol className="history">
      {history.entries.map((entry) => (
        <li key={entry.id} className={entry.bookingStatus === 'no_show' ? 'no-show' : undefined}>
          <div>
            <strong>{entry.reasonLabel}</strong>
            {entry.details ? <span className="history-details">{entry.details}</span> : null}
            <span className="muted small">
              {entry.when}
              {entry.author ? ` · ${entry.author}` : ''}
            </span>
          </div>
          <div className="history-amount">
            <strong className={entry.delta < 0 ? 'negative' : 'positive'}>{signed(entry.delta)}</strong>
            <span className="muted small">saldo {entry.balanceAfter}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function AdjustForm({
  balance,
  pending,
  onSave,
}: {
  balance: number;
  pending: boolean;
  onSave: (delta: number, note: string) => void;
}) {
  const [direction, setDirection] = useState<1 | -1>(1);
  const [count, setCount] = useState('1');
  const [note, setNote] = useState('');
  const amount = Number(count);
  const valid = Number.isInteger(amount) && amount > 0;
  const delta = valid ? direction * amount : 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(delta, note);
      }}
    >
      <div className="segmented dialog-kinds" role="tablist" aria-label="Rodzaj korekty">
        <button type="button" role="tab" aria-selected={direction === 1} onClick={() => setDirection(1)}>
          Dopisz lekcje
        </button>
        <button type="button" role="tab" aria-selected={direction === -1} onClick={() => setDirection(-1)}>
          Odejmij lekcje
        </button>
      </div>
      <div className="form-grid">
        <label htmlFor="adjust-count">Ile lekcji</label>
        <input
          id="adjust-count"
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          required
        />
        <label htmlFor="adjust-note">Notatka</label>
        <input
          id="adjust-note"
          type="text"
          maxLength={500}
          value={note}
          placeholder="np. zwrot lekcji odwołanej przez szkołę"
          onChange={(e) => setNote(e.target.value)}
          required
        />
        <p className="muted small span-2">
          Na koncie: {lessonsLabel(balance)}
          {valid ? ` · po korekcie: ${lessonsLabel(balance + delta)}` : ''}. Korekta to nowy wpis w historii z autorem i
          notatką; wcześniejszych wpisów nie zmieniamy.
        </p>
      </div>
      <div className="modal-actions">
        <button type="submit" disabled={pending || !valid}>
          {pending ? 'Zapisuję…' : `Zapisz korektę (${valid ? signed(delta) : '—'})`}
        </button>
      </div>
    </form>
  );
}

interface ClientFields {
  displayName: string;
  email: string;
  phone: string;
  targetDate: string;
  notes: string;
  status: ClientStatus;
  creditLimit: number | null;
}

function ClientForm({
  client,
  defaultLimit,
  pending,
  onSave,
}: {
  client: ClientSummary | null;
  defaultLimit: number;
  pending: boolean;
  onSave: (payload: ClientFields) => void;
}) {
  const [displayName, setDisplayName] = useState(client?.displayName ?? '');
  const [email, setEmail] = useState(client?.email ?? '');
  const [phone, setPhone] = useState(client?.phone ?? '');
  const [targetDate, setTargetDate] = useState(client?.targetDate ?? '');
  const [notes, setNotes] = useState(client?.notes ?? '');
  const [status, setStatus] = useState<ClientStatus>(client?.status ?? 'new');
  const [limit, setLimit] = useState(String(client?.status === 'trusted' ? client.creditLimit : defaultLimit));
  const trusted = status === 'trusted';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ displayName, email, phone, targetDate, notes, status, creditLimit: trusted ? Number(limit) : null });
      }}
    >
      <div className="form-grid">
        <label htmlFor="client-name">Nazwa pary</label>
        <input
          id="client-name"
          type="text"
          maxLength={80}
          placeholder="np. Anna i Piotr"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          autoFocus={!client}
        />
        <label htmlFor="client-email">E-mail</label>
        <input id="client-email" type="email" placeholder="do logowania" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="client-phone">Telefon</label>
        <input id="client-phone" type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
        <label htmlFor="client-date">Data ślubu</label>
        <input id="client-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        <label htmlFor="client-notes">Notatki</label>
        <textarea id="client-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <label htmlFor="client-status">Status</label>
        <select id="client-status" value={status} onChange={(e) => setStatus(e.target.value as ClientStatus)}>
          {(['new', 'regular', 'trusted'] as const).map((value) => (
            <option key={value} value={value}>
              {CLIENT_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <p className="muted small span-2">{STATUS_HINTS[status]}</p>
        <label htmlFor="client-limit" className={trusted ? undefined : 'muted'}>
          Limit
        </label>
        <span className="unit-input">
          <input
            id="client-limit"
            type="number"
            inputMode="numeric"
            min={0}
            max={20}
            value={trusted ? limit : '0'}
            disabled={!trusted}
            onChange={(e) => setLimit(e.target.value)}
            required
          />
          lekcji poniżej zera
        </span>
        {client ? null : (
          <p className="muted small span-2">Z adresem e-mail para loguje się linkiem z maila i sama rezerwuje lekcje.</p>
        )}
      </div>
      <div className="modal-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Zapisuję…' : client ? 'Zapisz' : 'Dodaj parę'}
        </button>
      </div>
    </form>
  );
}

/** Wpłata gotówką: pakiet albo pojedyncze lekcje; kwota podpowiada się z cennika, ale można ją zmienić (np. rabat). */
function CashForm({
  balance,
  pricing,
  pending,
  onSave,
}: {
  balance: number;
  pricing: Pricing;
  pending: boolean;
  onSave: (payload: Omit<CashPayload, 'slug' | 'clientId'>, summary: string) => void;
}) {
  const SINGLE = 'single';
  const suggestion = (choice: string, count: string): string => {
    const pkg = pricing.packages.find((p) => p.id === choice);
    if (pkg) return formatMoneyInput(pkg.priceCents);
    const n = Number(count);
    return pricing.lessonPriceCents !== null && Number.isInteger(n) && n > 0 ? formatMoneyInput(pricing.lessonPriceCents * n) : '';
  };
  const firstChoice = pricing.packages[0]?.id ?? SINGLE;
  const [choice, setChoice] = useState(firstChoice);
  const [count, setCount] = useState('1');
  const [amount, setAmount] = useState(() => suggestion(firstChoice, '1'));
  const [amountEdited, setAmountEdited] = useState(false);
  const [note, setNote] = useState('');

  const pkg = pricing.packages.find((p) => p.id === choice) ?? null;
  const credits = pkg ? pkg.credits : Number(count);
  const amountCents = parseMoney(amount);
  const valid = Number.isInteger(credits) && credits >= 1 && credits <= 100 && amountCents !== null;
  const summary = valid ? `${formatMoney(amountCents, pricing.currency)}${pkg ? `, ${pkg.name}` : ''}, +${lessonsLabel(credits)}` : '';
  const change = (nextChoice: string, nextCount: string) => {
    setChoice(nextChoice);
    setCount(nextCount);
    // Kwota idzie za cennikiem, dopóki szkoła sama jej nie zmieni.
    if (!amountEdited) setAmount(suggestion(nextChoice, nextCount));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSave({ packageId: pkg?.id ?? null, credits: pkg ? null : credits, amountCents, note }, summary);
      }}
    >
      <div className="form-grid">
        <label htmlFor="cash-what">Za co</label>
        <select id="cash-what" value={choice} onChange={(e) => change(e.target.value, count)}>
          {pricing.packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {lessonsLabel(p.credits)} · {formatMoney(p.priceCents, pricing.currency)}
            </option>
          ))}
          <option value={SINGLE}>Pojedyncze lekcje</option>
        </select>
        {pkg ? null : (
          <>
            <label htmlFor="cash-count">Ile lekcji</label>
            <input
              id="cash-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={count}
              onChange={(e) => change(choice, e.target.value)}
              required
            />
          </>
        )}
        <label htmlFor="cash-amount">Kwota</label>
        <span className="unit-input">
          <input
            id="cash-amount"
            type="text"
            inputMode="decimal"
            placeholder="np. 900"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountEdited(true);
            }}
            required
          />
          zł
        </span>
        <label htmlFor="cash-note">Notatka</label>
        <input id="cash-note" type="text" maxLength={500} placeholder="opcjonalnie" value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="muted small span-2">
          Na koncie: {lessonsLabel(balance)}
          {valid ? ` · po wpłacie: ${lessonsLabel(balance + credits)}` : ''}. Wpłata zapisuje, kto przyjął gotówkę, kwotę i liczbę
          lekcji.
          {pricing.packages.length === 0 ? ' Pakiety lekcji dodasz w Ustawieniach.' : ''}
        </p>
      </div>
      <div className="modal-actions">
        <button type="submit" disabled={pending || !valid}>
          {pending ? 'Zapisuję…' : valid ? `Przyjmij gotówkę: ${summary}` : 'Przyjmij gotówkę'}
        </button>
      </div>
    </form>
  );
}
