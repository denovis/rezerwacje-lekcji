'use client';
// Strona ustawień: instruktorzy z godzinami pracy i wolnym, reguły grafiku, usługi z ceną i pakiety lekcji.
// Zmiany robimy w okienkach na miejscu (reguły w formularzu na stronie), a wynik pokazuje dymek na dole ekranu.
import { useState } from 'react';
import {
  describeWeeklyHours,
  formatLocalDay,
  formatMoney,
  formatMoneyInput,
  lessonsLabel,
  parseMoney,
  pluralize,
  WEEKDAY_SHORT,
} from '../../../../lib/format';
import { addDays } from '../../../../lib/local-time';
import type {
  ScheduleRules,
  ScheduleSetup,
  SetupException,
  SetupInstructor,
  SetupPackage,
  SetupService,
  WorkRange,
} from '../../../../lib/schedule-setup';
import { EXCEPTION_TITLES, ExceptionDetails, ExceptionForm, exceptionAddedMessage, type ExceptionKind } from '../exception-form';
import {
  addExceptionAction,
  cancelExceptionAction,
  saveInstructorAction,
  savePackageAction,
  saveRulesAction,
  saveServiceAction,
  setHoursAction,
} from '../setup-actions';
import { Modal, Toast, useAction, useToast } from '../ui';

type Dialog =
  | { type: 'instructor'; instructor: SetupInstructor | null }
  | { type: 'hours'; instructor: SetupInstructor }
  | { type: 'new-exception'; instructor: SetupInstructor }
  | { type: 'exception'; instructor: SetupInstructor; exception: SetupException }
  | { type: 'service'; service: SetupService | null }
  | { type: 'package'; pkg: SetupPackage | null };

export function SettingsView({ setup, slug }: { setup: ScheduleSetup; slug: string }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useToast();
  const done = (text: string) => {
    setDialog(null);
    setMessage({ kind: 'ok', text });
  };
  const active = setup.instructors.filter((i) => i.active);
  const inactive = setup.instructors.filter((i) => !i.active);

  return (
    <>
      <Toast message={message} onHide={() => setMessage(null)} />

      <nav className="settings-nav small" aria-label="Części ustawień">
        <a href="#instruktorzy">Instruktorzy</a>
        <a href="#reguly">Reguły grafiku</a>
        <a href="#uslugi">Usługi</a>
        <a href="#pakiety">Pakiety</a>
      </nav>

      <section id="instruktorzy" className="settings-section">
        <div className="section-head">
          <h2>Instruktorzy i godziny pracy</h2>
          <button type="button" className="secondary" onClick={() => setDialog({ type: 'instructor', instructor: null })}>
            + Dodaj instruktora
          </button>
        </div>
        {active.length === 0 ? (
          <p className="muted">Szkoła nie ma aktywnego instruktora, więc klienci nie widzą wolnych terminów.</p>
        ) : null}
        <div className="setting-cards">
          {active.map((instructor) => (
            <InstructorCard
              key={instructor.id}
              instructor={instructor}
              today={setup.today}
              onEdit={() => setDialog({ type: 'instructor', instructor })}
              onHours={() => setDialog({ type: 'hours', instructor })}
              onNewException={() => setDialog({ type: 'new-exception', instructor })}
              onException={(exception) => setDialog({ type: 'exception', instructor, exception })}
            />
          ))}
        </div>
        {inactive.length > 0 ? (
          <div className="inactive-list">
            <h3>Wyłączeni instruktorzy</h3>
            <ul className="row-list">
              {inactive.map((instructor) => (
                <li key={instructor.id}>
                  <button type="button" className="row-button" onClick={() => setDialog({ type: 'instructor', instructor })}>
                    <span>{instructor.name}</span>
                    <span className="muted small">wyłączony · zmień ›</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section id="reguly" className="settings-section">
        <h2>Reguły grafiku</h2>
        <RulesForm
          rules={setup.rules}
          slug={slug}
          onSaved={() => setMessage({ kind: 'ok', text: 'Zapisano reguły grafiku. Wolne terminy liczą się już według nich.' })}
          onError={(text) => setMessage({ kind: 'error', text })}
        />
      </section>

      <section id="uslugi" className="settings-section">
        <div className="section-head">
          <h2>Usługi</h2>
          <button type="button" className="secondary" onClick={() => setDialog({ type: 'service', service: null })}>
            + Dodaj usługę
          </button>
        </div>
        <ul className="row-list">
          {setup.services.map((service) => (
            <li key={service.id}>
              <button type="button" className="row-button" onClick={() => setDialog({ type: 'service', service })}>
                <span>
                  <strong>{service.name}</strong>
                  <span className="muted small">
                    {' '}
                    · {service.durationMinutes} min · zdejmuje z konta {pluralize(service.creditCost, 'lekcję', 'lekcje', 'lekcji')}
                    {service.priceCents !== null ? ` · ${formatMoney(service.priceCents, setup.currency)}` : ' · bez ceny'}
                  </span>
                </span>
                <span className="muted small">{service.active ? 'zmień ›' : 'wyłączona · zmień ›'}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section id="pakiety" className="settings-section">
        <div className="section-head">
          <h2>Pakiety lekcji</h2>
          <button type="button" className="secondary" onClick={() => setDialog({ type: 'package', pkg: null })}>
            + Dodaj pakiet
          </button>
        </div>
        {setup.packages.length === 0 ? (
          <p className="muted small">Brak pakietów. Pakiet to gotowa liczba lekcji w jednej cenie, np. 5 lekcji za 900 zł.</p>
        ) : (
          <ul className="row-list">
            {setup.packages.map((pkg) => (
              <li key={pkg.id}>
                <button type="button" className="row-button" onClick={() => setDialog({ type: 'package', pkg })}>
                  <span>
                    <strong>{pkg.name}</strong>
                    <span className="muted small">
                      {' '}
                      · {lessonsLabel(pkg.credits)} · {formatMoney(pkg.priceCents, setup.currency)}
                    </span>
                  </span>
                  <span className="muted small">{pkg.active ? 'zmień ›' : 'wyłączony · zmień ›'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog ? <SettingsDialog key={dialogKey(dialog)} dialog={dialog} setup={setup} slug={slug} onClose={() => setDialog(null)} onDone={done} /> : null}
    </>
  );
}

function dialogKey(dialog: Dialog): string {
  if (dialog.type === 'service') return `service:${dialog.service?.id ?? 'new'}`;
  if (dialog.type === 'package') return `package:${dialog.pkg?.id ?? 'new'}`;
  if (dialog.type === 'instructor') return `instructor:${dialog.instructor?.id ?? 'new'}`;
  if (dialog.type === 'exception') return `exception:${dialog.exception.id}`;
  return `${dialog.type}:${dialog.instructor.id}`;
}

function InstructorCard({
  instructor,
  today,
  onEdit,
  onHours,
  onNewException,
  onException,
}: {
  instructor: SetupInstructor;
  today: string;
  onEdit: () => void;
  onHours: () => void;
  onNewException: () => void;
  onException: (exception: SetupException) => void;
}) {
  const { current, planned } = instructor;
  const lines = current ? describeWeeklyHours(current.ranges) : [];
  // Godziny, które się kończą, a po nich nie ma zaplanowanych nowych.
  const endsWithoutNext = current?.validTo && planned[0]?.validFrom !== addDays(current.validTo, 1);

  return (
    <article className="setting-card">
      <header className="setting-card-head">
        <div>
          <h3>{instructor.name}</h3>
          <p className="muted small">
            {instructor.email ? `Widzi swoje lekcje po zalogowaniu: ${instructor.email}` : 'Bez konta w aplikacji'}
          </p>
        </div>
        <button type="button" className="secondary compact" onClick={onEdit}>
          Zmień
        </button>
      </header>

      <div className="setting-block">
        <h4>Stałe godziny pracy</h4>
        {lines.length > 0 ? (
          <ul className="hours-lines">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{current ? 'Brak godzin pracy.' : 'Brak godzin pracy: klienci nie widzą wolnych terminów.'}</p>
        )}
        {endsWithoutNext && current?.validTo ? (
          <p className="small">Obowiązują do {formatLocalDay(current.validTo)}.</p>
        ) : null}
        {planned.map((version) => (
          <p key={version.validFrom} className="small planned">
            Od {version.validFrom === today ? 'dziś' : formatLocalDay(version.validFrom)}:{' '}
            {describeWeeklyHours(version.ranges).join('; ') || 'bez godzin pracy'}
          </p>
        ))}
        <button type="button" className="link-button accent" onClick={onHours}>
          Zmień godziny pracy
        </button>
      </div>

      <div className="setting-block">
        <h4>Wolne i dodatkowe godziny</h4>
        {instructor.exceptions.length > 0 ? (
          <ul className="row-list">
            {instructor.exceptions.map((exception) => (
              <li key={exception.id}>
                <button type="button" className={`row-button band-row ${exception.kind}`} onClick={() => onException(exception)}>
                  <span>
                    <strong>{EXCEPTION_TITLES[exception.kind]}</strong> <span className="capitalize-none">{exception.label}</span>
                    {exception.note ? <span className="muted small"> · {exception.note}</span> : null}
                  </span>
                  <span className="muted small">odwołaj ›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Brak zaplanowanych.</p>
        )}
        <button type="button" className="link-button accent" onClick={onNewException}>
          + Wolne albo dodatkowe godziny
        </button>
      </div>
    </article>
  );
}

function SettingsDialog({
  dialog,
  setup,
  slug,
  onClose,
  onDone,
}: {
  dialog: Dialog;
  setup: ScheduleSetup;
  slug: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { pending, error, run } = useAction();
  const [kind, setKind] = useState<ExceptionKind>('unavailable');

  let body;
  if (dialog.type === 'instructor') {
    body = <InstructorForm instructor={dialog.instructor} slug={slug} pending={pending} run={run} onDone={onDone} />;
  } else if (dialog.type === 'hours') {
    body = <HoursForm instructor={dialog.instructor} today={setup.today} slug={slug} pending={pending} run={run} onDone={onDone} />;
  } else if (dialog.type === 'service') {
    body = <ServiceForm service={dialog.service} slug={slug} pending={pending} run={run} onDone={onDone} />;
  } else if (dialog.type === 'package') {
    body = <PackageForm pkg={dialog.pkg} currency={setup.currency} slug={slug} pending={pending} run={run} onDone={onDone} />;
  } else if (dialog.type === 'exception') {
    const { exception, instructor } = dialog;
    body = (
      <ExceptionDetails
        kind={exception.kind}
        periodLabel={exception.label}
        instructorName={instructor.name}
        note={exception.note}
        pending={pending}
        onCancel={() =>
          run(
            () => cancelExceptionAction({ slug, exceptionId: exception.id }),
            () => onDone(`Odwołano: ${EXCEPTION_TITLES[exception.kind].toLowerCase()}, ${exception.label}.`),
          )
        }
      />
    );
  } else {
    const { instructor } = dialog;
    body = (
      <>
        <div className="segmented dialog-kinds" role="tablist" aria-label="Co wpisać">
          {(['unavailable', 'extra'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} onClick={() => setKind(value)} disabled={pending}>
              {EXCEPTION_TITLES[value]}
            </button>
          ))}
        </div>
        <h2>
          {kind === 'unavailable' ? 'Wolne' : 'Dodatkowe godziny'}: {instructor.name}
        </h2>
        <ExceptionForm
          key={kind}
          kind={kind}
          instructors={[{ id: instructor.id, name: instructor.name }]}
          defaults={{ instructorId: instructor.id, date: setup.today, time: '' }}
          pending={pending}
          onSubmit={(payload, summary) =>
            run(
              () => addExceptionAction({ slug, ...payload }),
              (result) => onDone(exceptionAddedMessage(payload.kind, `${instructor.name}, ${summary}`, result.lessonsInside ?? 0)),
            )
          }
        />
      </>
    );
  }

  return (
    <Modal onClose={onClose} pending={pending} error={error}>
      {body}
    </Modal>
  );
}

type Run = ReturnType<typeof useAction>['run'];

interface FormProps {
  slug: string;
  pending: boolean;
  run: Run;
  onDone: (message: string) => void;
}

function InstructorForm({ instructor, slug, pending, run, onDone }: FormProps & { instructor: SetupInstructor | null }) {
  const [name, setName] = useState(instructor?.name ?? '');
  const [email, setEmail] = useState(instructor?.email ?? '');
  const save = (active: boolean, text: string) =>
    run(() => saveInstructorAction({ slug, instructorId: instructor?.id, name, email, active }), () => onDone(text));

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(instructor?.active ?? true, instructor ? `Zapisano: ${name.trim()}.` : `Dodano instruktora: ${name.trim()}. Teraz ustaw godziny pracy.`);
        }}
      >
        <h2>{instructor ? 'Instruktor' : 'Nowy instruktor'}</h2>
        <div className="form-grid">
          <label htmlFor="instructor-name">Imię i nazwisko</label>
          <input id="instructor-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required autoFocus />
          <label htmlFor="instructor-email">E-mail</label>
          <input
            id="instructor-email"
            type="email"
            value={email}
            placeholder="opcjonalnie"
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="muted small span-2">
            Z adresem e-mail instruktor loguje się linkiem z maila i widzi lekcje, które prowadzi. Nie może ich zmieniać.
          </p>
        </div>
        <div className="modal-actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Zapisuję…' : instructor ? 'Zapisz' : 'Dodaj instruktora'}
          </button>
        </div>
      </form>
      {instructor ? (
        <div className="modal-actions">
          {instructor.active ? (
            <>
              <p className="small">
                Wyłączony instruktor znika z grafiku, a klienci nie widzą jego terminów.
                {instructor.upcomingLessons > 0
                  ? ` Zaplanowane lekcje (${instructor.upcomingLessons}) zostają w kalendarzu: odwołaj je, jeśli trzeba.`
                  : ''}
              </p>
              <button type="button" className="secondary danger-outline" disabled={pending} onClick={() => save(false, `Wyłączono instruktora: ${name.trim()}.`)}>
                Wyłącz instruktora
              </button>
            </>
          ) : (
            <button type="button" className="secondary" disabled={pending} onClick={() => save(true, `Włączono instruktora: ${name.trim()}.`)}>
              Włącz instruktora
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

type DayRanges = { start: string; end: string }[];

const DEFAULT_RANGE = { start: '16:00', end: '21:00' };
const pad = (n: number) => String(n).padStart(2, '0');
const shift = (time: string, minutes: number) => {
  const total = Math.min(Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes, 23 * 60 + 55);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

function HoursForm({ instructor, today, slug, pending, run, onDone }: FormProps & { instructor: SetupInstructor; today: string }) {
  const source = instructor.current?.ranges ?? instructor.planned[0]?.ranges ?? [];
  const [validFrom, setValidFrom] = useState(today);
  const [days, setDays] = useState<DayRanges[]>(() =>
    Array.from({ length: 7 }, (_, index) =>
      source.filter((r) => r.weekday === index + 1).map((r) => ({ start: r.start, end: r.end })),
    ),
  );
  const replaced = instructor.planned.filter((p) => p.validFrom >= validFrom);

  const update = (index: number, ranges: DayRanges) => setDays((all) => all.map((day, i) => (i === index ? ranges : day)));
  /** Zaznaczenie dnia kopiuje godziny z najbliższego wcześniejszego dnia pracy, żeby nie wpisywać ich od nowa. */
  const toggle = (index: number, on: boolean) => {
    if (!on) return update(index, []);
    const order = [...Array.from({ length: index }, (_, i) => index - 1 - i), ...Array.from({ length: 6 - index }, (_, i) => index + 1 + i)];
    const template = order.map((i) => days[i]).find((day) => day && day.length > 0);
    update(index, template ? template.map((r) => ({ ...r })) : [{ ...DEFAULT_RANGE }]);
  };

  const submit = () => {
    const ranges: WorkRange[] = days.flatMap((day, index) => day.map((r) => ({ weekday: index + 1, start: r.start, end: r.end })));
    run(
      () => setHoursAction({ slug, instructorId: instructor.id, validFrom, ranges }),
      () => onDone(`Zapisano godziny pracy: ${instructor.name}, od ${validFrom === today ? 'dziś' : formatLocalDay(validFrom)}.`),
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h2>Godziny pracy: {instructor.name}</h2>
      <div className="hours-grid">
        {days.map((ranges, index) => {
          const id = `hours-day-${index + 1}`;
          return (
            <div key={id} className="hours-day">
              <span className="check">
                <input id={id} type="checkbox" checked={ranges.length > 0} onChange={(e) => toggle(index, e.target.checked)} />
                <label htmlFor={id}>{WEEKDAY_SHORT[index]}</label>
              </span>
              <div className="hours-ranges">
                {ranges.length === 0 ? <span className="muted small">wolne</span> : null}
                {ranges.map((range, r) => (
                  <span key={r} className="time-range">
                    <input
                      aria-label={`${WEEKDAY_SHORT[index]} od`}
                      type="time"
                      step={300}
                      value={range.start}
                      required
                      onChange={(e) => update(index, ranges.map((x, i) => (i === r ? { ...x, start: e.target.value } : x)))}
                    />
                    –
                    <input
                      aria-label={`${WEEKDAY_SHORT[index]} do`}
                      type="time"
                      step={300}
                      value={range.end}
                      required
                      onChange={(e) => update(index, ranges.map((x, i) => (i === r ? { ...x, end: e.target.value } : x)))}
                    />
                    {ranges.length > 1 ? (
                      <button
                        type="button"
                        className="link-button"
                        aria-label="Usuń ten odcinek"
                        onClick={() => update(index, ranges.filter((_, i) => i !== r))}
                      >
                        ✕
                      </button>
                    ) : null}
                    {/* „+” w tej samej linii co ostatni odcinek: zaznaczenie dnia nie przesuwa kolejnych wierszy. */}
                    {r === ranges.length - 1 && ranges.length < 4 ? (
                      <button
                        type="button"
                        className="link-button small"
                        aria-label={`Dodaj drugi odcinek godzin: ${WEEKDAY_SHORT[index]}`}
                        title="Dodaj drugi odcinek godzin (np. po przerwie)"
                        onClick={() => update(index, [...ranges, { start: shift(range.end, 60), end: shift(range.end, 180) }])}
                      >
                        + odcinek
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="form-grid">
        <label htmlFor="hours-from">Obowiązują od</label>
        <input id="hours-from" type="date" value={validFrom} min={today} onChange={(e) => setValidFrom(e.target.value)} required />
        <p className="muted small span-2">
          Dni wcześniej zostają bez zmian. Zarezerwowane lekcje zostają w kalendarzu.
          {replaced.length > 0
            ? ` Zastąpi to zmianę zaplanowaną od ${replaced.map((p) => formatLocalDay(p.validFrom)).join(', ')}.`
            : ''}
        </p>
      </div>
      <div className="modal-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Zapisuję…' : 'Zapisz godziny'}
        </button>
      </div>
    </form>
  );
}

function ServiceForm({ service, slug, pending, run, onDone }: FormProps & { service: SetupService | null }) {
  const [name, setName] = useState(service?.name ?? '');
  const [duration, setDuration] = useState(String(service?.durationMinutes ?? 45));
  const [cost, setCost] = useState(String(service?.creditCost ?? 1));
  const [price, setPrice] = useState(service?.priceCents != null ? formatMoneyInput(service.priceCents) : '');
  const save = (active: boolean, text: string) =>
    run(
      () =>
        saveServiceAction({
          slug,
          serviceId: service?.id,
          name,
          durationMinutes: Number(duration),
          creditCost: Number(cost),
          // Puste pole: bez ceny; zła kwota trafia do serwera jako -1 i wraca z komunikatem o zakresie.
          priceCents: price.trim() === '' ? null : (parseMoney(price) ?? -1),
          active,
        }),
      () => onDone(text),
    );

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(service?.active ?? true, service ? `Zapisano usługę: ${name.trim()}.` : `Dodano usługę: ${name.trim()}.`);
        }}
      >
        <h2>{service ? 'Usługa' : 'Nowa usługa'}</h2>
        <div className="form-grid">
          <label htmlFor="service-name">Nazwa</label>
          <input id="service-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required autoFocus />
          <label htmlFor="service-duration">Długość lekcji</label>
          <span className="unit-input">
            <input
              id="service-duration"
              type="number"
              inputMode="numeric"
              min={5}
              max={600}
              step={5}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              required
            />
            min
          </span>
          <label htmlFor="service-cost">Zdejmuje z konta</label>
          <span className="unit-input">
            <input
              id="service-cost"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              required
            />
            {pluralize(Number(cost) || 0, 'lekcję', 'lekcje', 'lekcji').replace(/^\S+ /, '')}
          </span>
          <label htmlFor="service-price">Cena lekcji</label>
          <span className="unit-input">
            <input
              id="service-price"
              type="text"
              inputMode="decimal"
              placeholder="np. 180"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            zł
          </span>
          <p className="muted small span-2">
            Cena pojedynczej lekcji: podpowiedź przy wpłacie gotówką, a od etapu 4b kwota płatności online. Puste pole: bez ceny.
          </p>
          {service ? (
            <p className="muted small span-2">Nowa długość i koszt dotyczą nowych rezerwacji. Zarezerwowane lekcje zostają bez zmian.</p>
          ) : null}
        </div>
        <div className="modal-actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Zapisuję…' : service ? 'Zapisz' : 'Dodaj usługę'}
          </button>
        </div>
      </form>
      {service ? (
        <div className="modal-actions">
          {service.active ? (
            <>
              <p className="small">Wyłączonej usługi klienci nie zarezerwują. Zarezerwowane lekcje zostają.</p>
              <button type="button" className="secondary danger-outline" disabled={pending} onClick={() => save(false, `Wyłączono usługę: ${name.trim()}.`)}>
                Wyłącz usługę
              </button>
            </>
          ) : (
            <button type="button" className="secondary" disabled={pending} onClick={() => save(true, `Włączono usługę: ${name.trim()}.`)}>
              Włącz usługę
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

/** Wartości formularza reguł jako tekst (pola liczbowe), wyprzedzenie w godzinach. */
interface RulesFields {
  backToBackSlots: boolean;
  slotStepMinutes: string;
  bufferMinutes: string;
  minGapMinutes: string;
  compactDays: boolean;
  minNoticeHours: string;
  maxAdvanceDays: string;
  cancelDeadlineHours: string;
  firstLessonPrepaid: boolean;
  defaultTrustedCreditLimit: string;
  paymentHoldMinutes: string;
  autoCompleteLessons: boolean;
  autoPromoteAfterFirstLesson: boolean;
}

type CheckField = 'backToBackSlots' | 'compactDays' | 'firstLessonPrepaid' | 'autoCompleteLessons' | 'autoPromoteAfterFirstLesson';

function toFields(rules: ScheduleRules): RulesFields {
  return {
    backToBackSlots: rules.backToBackSlots,
    slotStepMinutes: String(rules.slotStepMinutes),
    bufferMinutes: String(rules.bufferMinutes),
    minGapMinutes: String(rules.minGapMinutes),
    compactDays: rules.compactDays,
    minNoticeHours: String(rules.minNoticeMinutes / 60),
    maxAdvanceDays: String(rules.maxAdvanceDays),
    cancelDeadlineHours: String(rules.cancelDeadlineHours),
    firstLessonPrepaid: rules.firstLessonPrepaid,
    defaultTrustedCreditLimit: String(rules.defaultTrustedCreditLimit),
    paymentHoldMinutes: String(rules.paymentHoldMinutes),
    autoCompleteLessons: rules.autoCompleteLessons,
    autoPromoteAfterFirstLesson: rules.autoPromoteAfterFirstLesson,
  };
}

function toRules(fields: RulesFields): ScheduleRules {
  const number = (value: string) => (value.trim() === '' ? Number.NaN : Number(value.replace(',', '.')));
  return {
    backToBackSlots: fields.backToBackSlots,
    slotStepMinutes: number(fields.slotStepMinutes),
    bufferMinutes: number(fields.bufferMinutes),
    minGapMinutes: number(fields.minGapMinutes),
    compactDays: fields.compactDays,
    minNoticeMinutes: Math.round(number(fields.minNoticeHours) * 60),
    maxAdvanceDays: number(fields.maxAdvanceDays),
    cancelDeadlineHours: number(fields.cancelDeadlineHours),
    firstLessonPrepaid: fields.firstLessonPrepaid,
    defaultTrustedCreditLimit: number(fields.defaultTrustedCreditLimit),
    paymentHoldMinutes: number(fields.paymentHoldMinutes),
    autoCompleteLessons: fields.autoCompleteLessons,
    autoPromoteAfterFirstLesson: fields.autoPromoteAfterFirstLesson,
  };
}

function RulesForm({
  rules,
  slug,
  onSaved,
  onError,
}: {
  rules: ScheduleRules;
  slug: string;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [fields, setFields] = useState(() => toFields(rules));
  const { pending, run } = useAction();
  const changed = JSON.stringify(toRules(fields)) !== JSON.stringify(rules);
  const set = <K extends keyof RulesFields>(key: K, value: RulesFields[K]) => setFields((f) => ({ ...f, [key]: value }));

  const numberField = (key: Exclude<keyof RulesFields, CheckField>, label: string, unit: string, options: { step?: number; disabled?: boolean; hint?: string } = {}) => (
    <div className={`rule-row${options.disabled ? ' disabled' : ''}`}>
      <label htmlFor={`rule-${key}`}>{label}</label>
      <span className="unit-input">
        <input
          id={`rule-${key}`}
          type="number"
          inputMode="decimal"
          min={0}
          step={options.step ?? 1}
          value={fields[key]}
          disabled={options.disabled}
          onChange={(e) => set(key, e.target.value)}
          required
        />
        {unit}
      </span>
      {options.hint ? <span className="hint">{options.hint}</span> : null}
    </div>
  );

  const check = (key: CheckField, label: string, hint: string, options: { disabled?: boolean } = {}) => (
    <div className={`rule-row${options.disabled ? ' disabled' : ''}`}>
      <span className="check">
        <input
          id={`rule-${key}`}
          type="checkbox"
          checked={fields[key]}
          disabled={options.disabled}
          onChange={(e) => set(key, e.target.checked)}
        />
        <label htmlFor={`rule-${key}`}>{label}</label>
      </span>
      <span className="hint">{hint}</span>
    </div>
  );

  return (
    <form
      className="rules-form"
      onSubmit={(event) => {
        event.preventDefault();
        run(
          async () => {
            const result = await saveRulesAction({ slug, rules: toRules(fields) });
            if (!result.ok) onError(result.error);
            return result;
          },
          () => onSaved(),
        );
      }}
    >
      <fieldset>
        <legend>Kiedy zaczynają się lekcje</legend>
        {check(
          'backToBackSlots',
          'Lekcje jedna po drugiej',
          'Kolejna lekcja zaczyna się zaraz po poprzedniej (plus przerwa), a wolne terminy przyklejają się do rezerwacji, więc nie zostają dziury.',
        )}
        {numberField('slotStepMinutes', 'Albo: lekcje zaczynają się co', 'min', {
          step: 5,
          disabled: fields.backToBackSlots,
          hint: 'Działa po wyłączeniu „Lekcje jedna po drugiej”, np. co 30 min: 16:00, 16:30, 17:00…',
        })}
        {numberField('bufferMinutes', 'Przerwa po każdej lekcji', 'min', { step: 5 })}
        {numberField('minGapMinutes', 'Nie zostawiaj przerw krótszych niż', 'min', {
          step: 5,
          hint: '0 = bez tej reguły. Ukrywa terminy, po których zostałaby za krótka przerwa do innej lekcji.',
        })}
        {check(
          'compactDays',
          'Przyklejaj terminy do rezerwacji',
          'W dniu, w którym jest już lekcja, klienci widzą tylko terminy tuż przed nią i tuż po niej.',
        )}
      </fieldset>
      <fieldset>
        <legend>Rezerwacje i odwołania</legend>
        {numberField('minNoticeHours', 'Rezerwacja najpóźniej', 'godz. przed lekcją', { step: 0.5 })}
        {numberField('maxAdvanceDays', 'Rezerwacje najdalej', 'dni naprzód')}
        {numberField('cancelDeadlineHours', 'Odwołanie ze zwrotem lekcji do', 'godz. przed lekcją', {
          hint: 'Później lekcja przepada.',
        })}
        {check(
          'firstLessonPrepaid',
          'Pierwsza lekcja nowej pary tylko z płatnością online',
          'Nowa para bez lekcji na koncie płaci za pierwszą lekcję online (BLIK, karta, Przelewy24), a termin czeka na płatność. Bez płatności online w szkole dostaje informację, żeby skontaktowała się ze szkołą.',
        )}
        {numberField('paymentHoldMinutes', 'Termin czeka na płatność online', 'min', {
          step: 5,
          hint: 'Od 30 minut do 24 godzin (1440 min). Potem nieopłacony termin wraca do puli.',
        })}
      </fieldset>
      <fieldset>
        <legend>Klienci</legend>
        {numberField('defaultTrustedCreditLimit', 'Zaufana para może zejść do', 'lekcji poniżej zera', {
          hint: 'Domyślny limit dla pary, którą oznaczysz jako zaufaną. Każdej parze możesz go potem zmienić na stronie Klienci.',
        })}
      </fieldset>
      <fieldset>
        <legend>Po lekcji</legend>
        {check(
          'autoCompleteLessons',
          'Lekcja po swoim końcu zmienia się na odbytą',
          'Aplikacja sprawdza to co minutę. Nieobecność możesz oznaczyć także na lekcji odbytej.',
        )}
        {check(
          'autoPromoteAfterFirstLesson',
          'Nowa para po pierwszej odbytej lekcji staje się stała',
          fields.autoCompleteLessons
            ? 'Stała para rezerwuje kolejne lekcje z lekcji na koncie, bez płatności online za każdą lekcję.'
            : 'Działa razem z oznaczaniem lekcji jako odbytych (pole wyżej).',
          { disabled: !fields.autoCompleteLessons },
        )}
      </fieldset>
      <div className="form-foot">
        <button type="submit" disabled={pending || !changed}>
          {pending ? 'Zapisuję…' : 'Zapisz reguły'}
        </button>
        <span className="muted small">{changed ? 'Masz niezapisane zmiany.' : 'Zapisane.'}</span>
      </div>
    </form>
  );
}


function PackageForm({
  pkg,
  currency,
  slug,
  pending,
  run,
  onDone,
}: FormProps & { pkg: SetupPackage | null; currency: string }) {
  const [name, setName] = useState(pkg?.name ?? '');
  const [credits, setCredits] = useState(String(pkg?.credits ?? 5));
  const [price, setPrice] = useState(pkg ? formatMoneyInput(pkg.priceCents) : '');
  const priceCents = parseMoney(price);
  const save = (active: boolean, text: string) =>
    run(
      () =>
        savePackageAction({
          slug,
          packageId: pkg?.id,
          name,
          credits: Number(credits),
          // Zła kwota trafia do serwera jako -1 i wraca z komunikatem o zakresie.
          priceCents: priceCents ?? -1,
          active,
        }),
      () => onDone(text),
    );
  const perLesson = priceCents !== null && Number(credits) > 0 ? Math.round(priceCents / Number(credits)) : null;

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(pkg?.active ?? true, pkg ? `Zapisano pakiet: ${name.trim()}.` : `Dodano pakiet: ${name.trim()}.`);
        }}
      >
        <h2>{pkg ? 'Pakiet lekcji' : 'Nowy pakiet lekcji'}</h2>
        <div className="form-grid">
          <label htmlFor="package-name">Nazwa</label>
          <input
            id="package-name"
            type="text"
            value={name}
            maxLength={80}
            placeholder="np. Pakiet 5 lekcji"
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <label htmlFor="package-credits">Lekcji w pakiecie</label>
          <input
            id="package-credits"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            required
          />
          <label htmlFor="package-price">Cena</label>
          <span className="unit-input">
            <input
              id="package-price"
              type="text"
              inputMode="decimal"
              placeholder="np. 900"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
            zł
          </span>
          <p className="muted small span-2">
            {perLesson !== null ? `Wychodzi ${formatMoney(perLesson, currency)} za lekcję. ` : ''}
            {pkg ? 'Zmiana dotyczy kolejnych sprzedaży; wcześniejsze zostają z kwotą z chwili sprzedaży.' : ''}
          </p>
        </div>
        <div className="modal-actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Zapisuję…' : pkg ? 'Zapisz' : 'Dodaj pakiet'}
          </button>
        </div>
      </form>
      {pkg ? (
        <div className="modal-actions">
          {pkg.active ? (
            <>
              <p className="small">Wyłączonego pakietu nie da się sprzedać. Wcześniejsze sprzedaże zostają w historii.</p>
              <button type="button" className="secondary danger-outline" disabled={pending} onClick={() => save(false, `Wyłączono pakiet: ${name.trim()}.`)}>
                Wyłącz pakiet
              </button>
            </>
          ) : (
            <button type="button" className="secondary" disabled={pending} onClick={() => save(true, `Włączono pakiet: ${name.trim()}.`)}>
              Włącz pakiet
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}
