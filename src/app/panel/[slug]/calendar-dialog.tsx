'use client';
// Okienko kalendarza: rezerwacja wolnego terminu, wpisanie lekcji o dowolnej godzinie (szkoła),
// wolne i dodatkowe godziny instruktora (szkoła) oraz szczegóły lekcji z odwołaniem i nieobecnością (szkoła).
// Wynik akcji pokazujemy na miejscu, bez przechodzenia na inną stronę.
import Link from 'next/link';
import { useState } from 'react';
import { lessonsLabel } from '../../../lib/format';
import type { CalendarException, CalendarLesson, CalendarSlot, WeekData } from '../../../lib/week-layout';
import { bookAction, cancelAction } from './actions';
import { markNoShowAction, undoNoShowAction } from './client-actions';
import { EXCEPTION_TITLES, ExceptionDetails, ExceptionForm, exceptionAddedMessage, type ExceptionKind } from './exception-form';
import { addExceptionAction, cancelExceptionAction } from './setup-actions';
import { Modal, useAction } from './ui';

export type DialogState =
  | { type: 'slot'; slot: CalendarSlot }
  | { type: 'new'; date: string; time: string }
  | { type: 'lesson'; lesson: CalendarLesson }
  | { type: 'exception'; exception: CalendarException };

interface Props {
  state: DialogState;
  data: WeekData;
  slug: string;
  onClose: () => void;
  /** Akcja się udała: zamknij okienko i pokaż komunikat. */
  onDone: (message: string) => void;
}

/** Co szkoła wpisuje po kliknięciu w puste miejsce: lekcję, wolne albo dodatkowe godziny. */
type NewKind = 'lesson' | ExceptionKind;

const NEW_KINDS: { kind: NewKind; label: string }[] = [
  { kind: 'lesson', label: 'Lekcja' },
  { kind: 'unavailable', label: EXCEPTION_TITLES.unavailable },
  { kind: 'extra', label: EXCEPTION_TITLES.extra },
];

export function CalendarDialog({ state, data, slug, onClose, onDone }: Props) {
  const { pending, error, run } = useAction();
  const [newKind, setNewKind] = useState<NewKind>('lesson');

  let body;
  if (state.type === 'lesson') {
    const cancel = () =>
      run(
        () => cancelAction({ slug, bookingId: state.lesson.id }),
        (result) =>
          onDone(
            result.refunded
              ? `Lekcja odwołana i wróciła na konto${data.isStaff ? ' klienta' : ''}.`
              : 'Lekcja odwołana po terminie, więc przepada.',
          ),
      );
    const lesson = state.lesson;
    const noShow = () =>
      lesson.noShow === 'undo'
        ? run(
            () => undoNoShowAction({ slug, bookingId: lesson.id }),
            () => onDone(`Cofnięto nieobecność: ${lesson.clientName}, ${lesson.timeLabel}.`),
          )
        : run(
            () => markNoShowAction({ slug, bookingId: lesson.id }),
            () => onDone(`Oznaczono nieobecność: ${lesson.clientName}, ${lesson.timeLabel}. Lekcja przepada.`),
          );
    body = <LessonDetails lesson={lesson} data={data} slug={slug} pending={pending} onCancel={cancel} onNoShow={noShow} />;
  } else if (state.type === 'exception') {
    const exception = state.exception;
    body = (
      <ExceptionDetails
        kind={exception.kind}
        periodLabel={exception.periodLabel}
        instructorName={exception.instructorName}
        note={exception.note}
        pending={pending}
        onCancel={() =>
          run(
            () => cancelExceptionAction({ slug, exceptionId: exception.id }),
            () => onDone(`Odwołano: ${EXCEPTION_TITLES[exception.kind].toLowerCase()}, ${exception.periodLabel}.`),
          )
        }
      />
    );
  } else {
    const kinds = state.type === 'new' && data.isStaff;
    body = (
      <>
        {kinds ? (
          <div className="segmented dialog-kinds" role="tablist" aria-label="Co wpisać">
            {NEW_KINDS.map(({ kind, label }) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={newKind === kind}
                onClick={() => setNewKind(kind)}
                disabled={pending}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {state.type === 'new' && newKind !== 'lesson' ? (
          <>
            <h2>{newKind === 'unavailable' ? 'Wolne instruktora' : 'Dodatkowe godziny pracy'}</h2>
            <ExceptionForm
              key={newKind}
              kind={newKind}
              instructors={data.instructors}
              defaults={{ instructorId: data.instructors[0]?.id ?? '', date: state.date, time: state.time }}
              pending={pending}
              onSubmit={(payload, summary) =>
                run(
                  () => addExceptionAction({ slug, ...payload }),
                  (result) => onDone(exceptionAddedMessage(payload.kind, summary, result.lessonsInside ?? 0)),
                )
              }
            />
          </>
        ) : (
          <BookingForm
            state={state}
            data={data}
            pending={pending}
            onBook={(input, summary) =>
              run(() => bookAction({ slug, serviceId: data.service?.id ?? '', ...input }), () => onDone(`Zarezerwowano: ${summary}.`))
            }
          />
        )}
      </>
    );
  }

  return (
    <Modal onClose={onClose} pending={pending} error={error}>
      {body}
    </Modal>
  );
}

function LessonDetails({
  lesson,
  data,
  slug,
  pending,
  onCancel,
  onNoShow,
}: {
  lesson: CalendarLesson;
  data: WeekData;
  slug: string;
  pending: boolean;
  onCancel: () => void;
  onNoShow: () => void;
}) {
  // Szkoła i instruktor widzą parę, klient rodzaj lekcji.
  const forSchool = data.isStaff || data.isInstructor;
  return (
    <>
      <h2>{forSchool ? lesson.clientName : lesson.serviceName}</h2>
      <p>
        <strong className="capitalize">{lesson.dateLabel}</strong>, {lesson.timeLabel}
      </p>
      <p className="muted">
        {forSchool ? `${lesson.serviceName} · ` : ''}
        {data.isInstructor ? '' : `${lesson.instructorName} · `}
        {lesson.statusLabel}
      </p>
      {data.isStaff ? (
        <p className="small">
          <Link href={`/panel/${slug}/klienci?para=${lesson.clientId}`}>Historia lekcji i saldo pary ›</Link>
        </p>
      ) : null}
      {lesson.noShow === 'mark' ? (
        <div className="modal-actions">
          <p className="small">Para nie przyszła? Po oznaczeniu nieobecności lekcja przepada (nie wraca na konto).</p>
          <button type="button" className="secondary danger-outline" onClick={onNoShow} disabled={pending}>
            {pending ? 'Zapisuję…' : 'Oznacz nieobecność'}
          </button>
        </div>
      ) : lesson.noShow === 'undo' ? (
        <div className="modal-actions">
          <p className="small">Oznaczone pomyłkowo? Lekcja wróci do poprzedniego statusu.</p>
          <button type="button" className="secondary" onClick={onNoShow} disabled={pending}>
            {pending ? 'Zapisuję…' : 'Cofnij nieobecność'}
          </button>
        </div>
      ) : null}
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
      ) : data.isInstructor && lesson.status === 'confirmed' ? (
        <p className="small muted">Lekcję odwołuje para albo szkoła.</p>
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
  state: Extract<DialogState, { type: 'slot' | 'new' }>;
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
