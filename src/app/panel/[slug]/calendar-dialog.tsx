'use client';
// Okienko kalendarza: rezerwacja wolnego terminu, wpisanie lekcji o dowolnej godzinie (szkoła)
// i szczegóły lekcji z odwołaniem. Wynik akcji pokazujemy na miejscu, bez przechodzenia na inną stronę.
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { lessonsLabel } from '../../../lib/format';
import type { CalendarLesson, CalendarSlot, WeekData } from '../../../lib/week-layout';
import { bookAction, cancelAction, type ActionResult } from './actions';

export type DialogState =
  | { type: 'slot'; slot: CalendarSlot }
  | { type: 'new'; date: string; time: string }
  | { type: 'lesson'; lesson: CalendarLesson };

interface Props {
  state: DialogState;
  data: WeekData;
  slug: string;
  onClose: () => void;
  /** Akcja się udała: zamknij okienko i pokaż komunikat. */
  onDone: (message: string) => void;
}

export function CalendarDialog({ state, data, slug, onClose, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const run = (action: () => Promise<ActionResult>, success: (result: ActionResult & { ok: true }) => string) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        ref.current?.close();
        onDone(success(result));
      } else {
        setError(result.error);
      }
    });
  };

  let body: ReactNode;
  if (state.type === 'lesson') {
    const cancel = () =>
      run(
        () => cancelAction({ slug, bookingId: state.lesson.id }),
        (result) =>
          result.refunded
            ? `Lekcja odwołana i wróciła na konto${data.isStaff ? ' klienta' : ''}.`
            : 'Lekcja odwołana po terminie, więc przepada.',
      );
    body = <LessonDetails lesson={state.lesson} data={data} pending={pending} onCancel={cancel} />;
  } else {
    body = (
      <BookingForm
        state={state}
        data={data}
        pending={pending}
        onBook={(input, summary) =>
          run(() => bookAction({ slug, serviceId: data.service?.id ?? '', ...input }), () => `Zarezerwowano: ${summary}.`)
        }
      />
    );
  }

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onClick={(event) => {
        // Kliknięcie w tło zamyka okienko.
        if (event.target === ref.current && !pending) ref.current.close();
      }}
    >
      <div className="modal-body">
        {body}
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <p className="modal-actions-secondary">
          <button type="button" className="link-button" onClick={() => ref.current?.close()} disabled={pending}>
            Zamknij
          </button>
        </p>
      </div>
    </dialog>
  );
}

function LessonDetails({
  lesson,
  data,
  pending,
  onCancel,
}: {
  lesson: CalendarLesson;
  data: WeekData;
  pending: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      <h2>{data.isStaff ? lesson.clientName : lesson.serviceName}</h2>
      <p>
        <strong className="capitalize">{lesson.dateLabel}</strong>, {lesson.timeLabel}
      </p>
      <p className="muted">
        {data.isStaff ? `${lesson.serviceName} · ` : ''}
        {lesson.instructorName} · {lesson.statusLabel}
      </p>
      {lesson.cancel ? (
        <div className="modal-actions">
          <p className="small">
            {lesson.cancel.refundable
              ? `Odwołanie do ${lesson.cancel.deadlineLabel} zwraca lekcję na konto.`
              : 'Termin odwołania ze zwrotem minął: po odwołaniu lekcja przepadnie.'}
          </p>
          <button type="button" className="danger" onClick={onCancel} disabled={pending}>
            {pending ? 'Odwołuję…' : lesson.cancel.refundable ? 'Odwołaj lekcję' : 'Odwołaj (lekcja przepadnie)'}
          </button>
        </div>
      ) : null}
    </>
  );
}

interface BookPayload {
  clientId: string;
  instructorId: string;
  startsAt?: string;
  date?: string;
  time?: string;
}

function BookingForm({
  state,
  data,
  pending,
  onBook,
}: {
  state: Exclude<DialogState, { type: 'lesson' }>;
  data: WeekData;
  pending: boolean;
  onBook: (input: BookPayload, summary: string) => void;
}) {
  // Szkoła z jednym klientem nie musi go wybierać.
  const onlyClient = data.clients.length === 1 ? data.clients[0]!.id : '';
  const [clientId, setClientId] = useState(data.isStaff ? onlyClient : (data.client?.id ?? ''));
  const [date, setDate] = useState(state.type === 'new' ? state.date : '');
  const [time, setTime] = useState(state.type === 'new' ? state.time : '');
  const [instructorId, setInstructorId] = useState(
    state.type === 'slot' ? state.slot.instructorId : (data.instructors[0]?.id ?? ''),
  );
  const service = data.service;
  const many = data.instructors.length > 1;

  if (!service) return <p>Szkoła nie ma jeszcze żadnej usługi do rezerwacji.</p>;

  const dayLabel = (value: string) => data.days.find((d) => d.date === value)?.label ?? value;
  const clientName = data.clients.find((c) => c.id === clientId)?.name;
  const when = state.type === 'slot' ? `${state.slot.dateLabel}, ${state.slot.timeLabel.slice(0, 5)}` : `${dayLabel(date)}, ${time}`;
  const balanceAfter = data.client ? data.client.balance - service.creditCost : null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const where = state.type === 'slot' ? { startsAt: state.slot.startsAt } : { date, time };
        onBook({ clientId, instructorId, ...where }, clientName ? `${clientName}, ${when}` : when);
      }}
    >
      <h2>{data.isStaff ? 'Nowa lekcja' : 'Zarezerwować lekcję?'}</h2>

      {state.type === 'slot' ? (
        <>
          <p>
            <strong className="capitalize">{state.slot.dateLabel}</strong>, {state.slot.timeLabel}
          </p>
          <p className="muted">
            {service.name} · {state.slot.instructorName}
          </p>
        </>
      ) : (
        <div className="form-grid">
          <label htmlFor="lesson-date">Dzień</label>
          <input id="lesson-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <label htmlFor="lesson-time">Godzina</label>
          <input id="lesson-time" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} required />
          {many ? (
            <>
              <label htmlFor="lesson-instructor">Instruktor</label>
              <select id="lesson-instructor" value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
                {data.instructors.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <p className="muted small span-2">
            {service.name}, {service.durationMinutes} min. Szkoła może wpisać lekcję także poza godzinami pracy, jeśli nie
            nachodzi na inną.
          </p>
        </div>
      )}

      {data.isStaff ? (
        <div className="form-grid">
          <label htmlFor="lesson-client">Klient</label>
          <select id="lesson-client" value={clientId} onChange={(e) => setClientId(e.target.value)} required autoFocus>
            <option value="" disabled>
              Wybierz klienta…
            </option>
            {data.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : data.client && balanceAfter !== null ? (
        <p>
          Na koncie: <strong>{data.client.balanceLabel}</strong>
          {balanceAfter >= -data.client.creditLimit ? ` · po rezerwacji: ${lessonsLabel(balanceAfter)}` : null}
        </p>
      ) : null}

      <div className="modal-actions">
        <button type="submit" disabled={pending} autoFocus={!data.isStaff}>
          {pending ? 'Rezerwuję…' : 'Zarezerwuj'}
        </button>
      </div>
    </form>
  );
}
