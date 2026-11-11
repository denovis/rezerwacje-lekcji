'use client';
// Wolne (urlop, wolne na część dnia) i dodatkowe godziny instruktora: formularz i szczegóły z odwołaniem.
// Korzystają z nich kalendarz (kliknięcie w puste miejsce albo w szary pas) i strona ustawień.
import { useState } from 'react';
import { formatLocalDay, pluralize } from '../../../lib/format';
import type { ExceptionPayload } from './setup-actions';

export type ExceptionKind = 'unavailable' | 'extra';

export const EXCEPTION_TITLES: Record<ExceptionKind, string> = {
  unavailable: 'Wolne',
  extra: 'Dodatkowe godziny',
};

const pad = (n: number) => String(n).padStart(2, '0');
const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (minutes: number) => {
  const m = Math.min(Math.max(minutes, 0), 23 * 60 + 55);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

export interface ExceptionDefaults {
  instructorId: string;
  /** Dzień (RRRR-MM-DD), np. kliknięty w kalendarzu. */
  date: string;
  /** Kliknięta godzina (GG:MM); pusta = domyślna. */
  time: string;
}

/** Komunikat po dodaniu: lekcje w czasie wolnego zostają, więc szkoła o nich wie. */
export function exceptionAddedMessage(kind: ExceptionKind, summary: string, lessonsInside: number): string {
  const added = `${kind === 'unavailable' ? 'Dodano wolne' : 'Dodano dodatkowe godziny'}: ${summary}.`;
  if (lessonsInside === 0) return added;
  const lessons = pluralize(lessonsInside, 'lekcja zostaje', 'lekcje zostają', 'lekcji zostaje');
  return `${added} W tym czasie ${lessons} w kalendarzu: odwołaj je, jeśli trzeba.`;
}

export function ExceptionForm({
  kind,
  instructors,
  defaults,
  pending,
  onSubmit,
}: {
  kind: ExceptionKind;
  instructors: { id: string; name: string }[];
  defaults: ExceptionDefaults;
  pending: boolean;
  onSubmit: (payload: Omit<ExceptionPayload, 'slug'>, summary: string) => void;
}) {
  const startDefault = defaults.time || (kind === 'extra' ? '10:00' : '16:00');
  const [instructorId, setInstructorId] = useState(defaults.instructorId);
  const [allDay, setAllDay] = useState(kind === 'unavailable');
  const [startDate, setStartDate] = useState(defaults.date);
  const [endDate, setEndDate] = useState(defaults.date);
  const [startTime, setStartTime] = useState(startDefault);
  const [endTime, setEndTime] = useState(toTime(toMinutes(startDefault) + (kind === 'extra' ? 120 : 60)));
  const [note, setNote] = useState('');
  const many = instructors.length > 1;
  const isExtra = kind === 'extra';
  const id = (name: string) => `exception-${kind}-${name}`;

  const submit = () => {
    const wholeDays = !isExtra && allDay;
    const lastDay = isExtra ? startDate : endDate;
    const instructor = many ? `${instructors.find((i) => i.id === instructorId)?.name ?? ''}, ` : '';
    const when = wholeDays
      ? startDate === lastDay
        ? `${formatLocalDay(startDate)}, cały dzień`
        : `${formatLocalDay(startDate)} – ${formatLocalDay(lastDay)}`
      : startDate === lastDay
        ? `${formatLocalDay(startDate)}, ${startTime}–${endTime}`
        : `${formatLocalDay(startDate)}, ${startTime} – ${formatLocalDay(lastDay)}, ${endTime}`;
    onSubmit(
      {
        instructorId,
        kind,
        startDate,
        endDate: lastDay,
        startTime: wholeDays ? '' : startTime,
        endTime: wholeDays ? '' : endTime,
        note,
      },
      `${instructor}${when}`,
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="form-grid">
        {many ? (
          <>
            <label htmlFor={id('instructor')}>Instruktor</label>
            <select id={id('instructor')} value={instructorId} onChange={(e) => setInstructorId(e.target.value)}>
              {instructors.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </>
        ) : null}

        {isExtra ? (
          <>
            <label htmlFor={id('date')}>Dzień</label>
            <input id={id('date')} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            <span className="form-label">Godziny</span>
            <span className="time-range">
              <input aria-label="Od godziny" type="time" step={300} value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
              –
              <input aria-label="Do godziny" type="time" step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
            </span>
          </>
        ) : (
          <>
            <span className="span-2 check">
              <input id={id('all-day')} type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              <label htmlFor={id('all-day')}>Całe dni (urlop)</label>
            </span>
            <label htmlFor={id('start-date')}>Od</label>
            <span className="time-range">
              <input
                id={id('start-date')}
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (e.target.value > endDate) setEndDate(e.target.value);
                }}
                required
              />
              {allDay ? null : (
                <input aria-label="Od godziny" type="time" step={300} value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
              )}
            </span>
            <label htmlFor={id('end-date')}>Do</label>
            <span className="time-range">
              <input id={id('end-date')} type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
              {allDay ? null : (
                <input aria-label="Do godziny" type="time" step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
              )}
            </span>
          </>
        )}

        <label htmlFor={id('note')}>Notatka</label>
        <input
          id={id('note')}
          type="text"
          value={note}
          maxLength={200}
          placeholder={isExtra ? 'np. sobota przed ślubami' : 'np. urlop'}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="muted small span-2">
          {isExtra
            ? 'W tych godzinach klienci zobaczą dodatkowe wolne terminy.'
            : 'W tym czasie klienci nie zobaczą wolnych terminów. Zarezerwowane lekcje zostają w kalendarzu.'}
        </p>
      </div>
      <div className="modal-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Zapisuję…' : isExtra ? 'Dodaj godziny' : 'Zapisz wolne'}
        </button>
      </div>
    </form>
  );
}

export function ExceptionDetails({
  kind,
  periodLabel,
  instructorName,
  note,
  pending,
  onCancel,
}: {
  kind: ExceptionKind;
  periodLabel: string;
  instructorName: string;
  note: string | null;
  pending: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      <h2>{EXCEPTION_TITLES[kind]}</h2>
      <p>
        <strong className="capitalize">{periodLabel}</strong>
      </p>
      <p className="muted">
        {instructorName}
        {note ? ` · ${note}` : ''}
      </p>
      <div className="modal-actions">
        <p className="small">
          {kind === 'unavailable'
            ? 'Po odwołaniu wolnego klienci znowu zobaczą w tym czasie wolne terminy.'
            : 'Po odwołaniu dodatkowych godzin ich wolne terminy znikną. Zarezerwowane lekcje zostają.'}
        </p>
        <button type="button" className="danger" onClick={onCancel} disabled={pending}>
          {pending ? 'Odwołuję…' : kind === 'unavailable' ? 'Odwołaj wolne' : 'Odwołaj dodatkowe godziny'}
        </button>
      </div>
    </>
  );
}
