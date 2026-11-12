'use client';
// Kalendarz tygodniowy panelu: siatka godzin jak w Google Calendar albo prostsza lista dni.
// Klient klika wolny termin, żeby zarezerwować, i swoją lekcję, żeby ją odwołać.
// Szkoła dodatkowo klika puste miejsce w siatce, żeby wpisać lekcję o dowolnej godzinie, wolne
// albo dodatkowe godziny; wolne widać jako szary pas. Instruktor tylko ogląda swoje lekcje.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import {
  layoutDay,
  type CalendarDay,
  type CalendarException,
  type CalendarLesson,
  type CalendarSlot,
  type WeekData,
} from '../../../lib/week-layout';
import { CalendarDialog, type DialogState } from './calendar-dialog';
import { EXCEPTION_TITLES } from './exception-form';
import { Toast, useToast, type Message } from './ui';

/** Wysokość minuty w siatce (godzina = 72 px). */
const PX_PER_MINUTE = 1.2;
/** Kliknięcie w pustą siatkę zaokrąglamy do tylu minut. */
const SNAP_MINUTES = 15;

export interface CalendarLinks {
  previous: string;
  next: string;
  current: string;
  calendar: string;
  list: string;
}

type View = 'calendar' | 'list';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function WeekCalendar({
  data,
  slug,
  view,
  links,
  notice = null,
}: {
  data: WeekData;
  slug: string;
  view: View;
  links: CalendarLinks;
  /** Komunikat do pokazania po wejściu na stronę (np. po powrocie ze strony płatności). */
  notice?: Message | null;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useToast();

  // Komunikat po powrocie ze strony płatności pokazujemy raz; adres bez ?platnosc=… nie pokaże go po odświeżeniu.
  // Adres zmieniamy przez router Next.js, żeby kolejne odświeżenie danych (po akcji) nie przywróciło parametrów.
  const router = useRouter();
  useEffect(() => {
    if (!notice) return;
    setMessage(notice);
    const url = new URL(window.location.href);
    url.searchParams.delete('platnosc');
    url.searchParams.delete('sesja');
    router.replace(url.pathname + url.search, { scroll: false });
  }, []); // tylko raz, po wejściu na stronę

  const open = (state: DialogState) => setDialog(state);
  const canBookAt = (date: string, minutes: number) =>
    date > data.now.date || (date === data.now.date && minutes > data.now.minutes);
  const firstOpenDay = data.days.find((d) => !d.isPast)?.date ?? data.now.date;
  const weekIsPast = data.days.every((d) => d.isPast);
  const handlers: Handlers = {
    onSlot: (slot) => open({ type: 'slot', slot }),
    onLesson: (lesson) => open({ type: 'lesson', lesson }),
    onException: (exception) => open({ type: 'exception', exception }),
  };

  return (
    <section className="calendar" aria-label="Kalendarz">
      <div className="cal-toolbar">
        <div className="cal-nav">
          <Link href={links.previous} scroll={false} className="icon-button" aria-label="Poprzedni tydzień">
            ‹
          </Link>
          <Link href={links.current} scroll={false} className="pill">
            Dziś
          </Link>
          <Link href={links.next} scroll={false} className="icon-button" aria-label="Następny tydzień">
            ›
          </Link>
          <h2>{data.title}</h2>
        </div>
        <div className="cal-tools">
          {data.isStaff && data.service ? (
            <button type="button" onClick={() => open({ type: 'new', date: firstOpenDay, time: '' })}>
              + Nowa lekcja
            </button>
          ) : null}
          <nav className="segmented" aria-label="Widok">
            <Link href={links.calendar} scroll={false} aria-current={view === 'calendar' ? 'page' : undefined}>
              Kalendarz
            </Link>
            <Link href={links.list} scroll={false} aria-current={view === 'list' ? 'page' : undefined}>
              Lista
            </Link>
          </nav>
        </div>
      </div>

      {/* Komunikat po akcji w dymku na dole ekranu: nie przesuwa kalendarza i sam znika. */}
      <Toast message={message} onHide={() => setMessage(null)} />

      <p className="muted small legend">
        <span className="legend-item">
          <span className="swatch swatch-lesson" /> {data.isStaff ? 'lekcja' : 'Twoja lekcja'}
        </span>
        {data.isInstructor ? null : (
          <span className="legend-item">
            <span className="swatch swatch-slot" /> wolny termin
          </span>
        )}
        {data.isStaff ? (
          <span className="legend-item">
            <span className="swatch swatch-off" /> urlop, wolne
          </span>
        ) : null}
        <span>
          {data.isInstructor
            ? 'Lekcje, które prowadzisz. Kliknij lekcję, żeby zobaczyć szczegóły.'
            : data.isStaff
              ? view === 'calendar'
                ? 'Kliknij puste miejsce, żeby wpisać lekcję, wolne albo dodatkowe godziny. Kliknij lekcję albo wolne, żeby je odwołać.'
                : 'Kliknij wolną godzinę, żeby wpisać lekcję. Kliknij lekcję albo wolne, żeby je odwołać.'
              : 'Kliknij wolny termin, żeby zarezerwować. Kliknij swoją lekcję, żeby ją odwołać.'}
        </span>
      </p>

      {view === 'calendar' ? (
        <CalendarGrid
          data={data}
          {...handlers}
          onEmpty={
            data.isStaff
              ? (date, minutes) => {
                  if (canBookAt(date, minutes)) open({ type: 'new', date, time: clock(minutes) });
                }
              : undefined
          }
        />
      ) : (
        <AgendaList data={data} {...handlers} />
      )}

      {!weekIsPast && data.service && data.slots.length === 0 ? (
        <p className="muted">
          W tym tygodniu nie ma już wolnych terminów.{' '}
          <Link href={links.next} scroll={false}>
            Następny tydzień →
          </Link>
        </p>
      ) : null}

      {dialog ? (
        <CalendarDialog
          key={dialogKey(dialog)}
          state={dialog}
          data={data}
          slug={slug}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            setMessage({ kind: 'ok', text });
          }}
        />
      ) : null}
    </section>
  );
}

function dialogKey(state: DialogState): string {
  if (state.type === 'slot') return `slot:${state.slot.key}`;
  if (state.type === 'lesson') return `lesson:${state.lesson.id}`;
  if (state.type === 'exception') return `exception:${state.exception.key}`;
  return `new:${state.date}:${state.time}`;
}

interface Handlers {
  onSlot: (slot: CalendarSlot) => void;
  onLesson: (lesson: CalendarLesson) => void;
  onException: (exception: CalendarException) => void;
}

type GridItem = ({ kind: 'lesson'; lesson: CalendarLesson } | { kind: 'slot'; slot: CalendarSlot }) & {
  start: number;
  end: number;
};

function CalendarGrid({
  data,
  onEmpty,
  ...handlers
}: Handlers & {
  data: WeekData;
  onEmpty?: (date: string, minutes: number) => void;
}) {
  const { range } = data;
  const hours: number[] = [];
  for (let m = range.start; m < range.end; m += 60) hours.push(m);
  const style = {
    '--hour-height': `${60 * PX_PER_MINUTE}px`,
    '--grid-height': `${(range.end - range.start) * PX_PER_MINUTE}px`,
  } as CSSProperties;

  // Na wąskim ekranie (telefon) tydzień się nie mieści: przewijamy od razu do dzisiejszego dnia,
  // żeby minione dni nie zasłaniały wolnych terminów.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scroller.current;
    const firstOpen = box?.querySelector<HTMLElement>('.cal-dayhead:not(.past)');
    const times = box?.querySelector<HTMLElement>('.cal-corner');
    if (!box || !firstOpen || box.scrollWidth <= box.clientWidth) return;
    const offset = firstOpen.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    box.scrollLeft = offset - (times?.offsetWidth ?? 0);
  }, [data.weekStart]);

  return (
    <div className="cal-scroll" ref={scroller}>
      <div className="cal" style={style}>
        <div className="cal-corner" />
        {data.days.map((day) => (
          <div key={day.date} className={`cal-dayhead${day.isToday ? ' today' : ''}${day.isPast ? ' past' : ''}`}>
            <span className="cal-weekday">{day.weekdayShort}</span>
            <span className="cal-daynum">{day.dayOfMonth}</span>
          </div>
        ))}
        <div className="cal-times" aria-hidden="true">
          {hours.map((m) => (
            <span key={m} style={{ top: (m - range.start) * PX_PER_MINUTE }}>
              {clock(m)}
            </span>
          ))}
        </div>
        {data.days.map((day) => (
          <DayColumn key={day.date} day={day} data={data} onEmpty={onEmpty} {...handlers} />
        ))}
      </div>
    </div>
  );
}

function DayColumn({
  day,
  data,
  onSlot,
  onLesson,
  onException,
  onEmpty,
}: Handlers & {
  day: CalendarDay;
  data: WeekData;
  onEmpty?: (date: string, minutes: number) => void;
}) {
  const { range } = data;
  const items: GridItem[] = [
    ...data.lessons
      .filter((l) => l.date === day.date && l.blocksCalendar)
      .map((lesson) => ({ kind: 'lesson' as const, lesson, start: lesson.start, end: lesson.end })),
    ...data.slots
      .filter((s) => s.date === day.date)
      .map((slot) => ({ kind: 'slot' as const, slot, start: slot.start, end: slot.end })),
  ];
  // Wolne i dodatkowe godziny to pasy w tle: lekcje i wolne terminy leżą nad nimi.
  // Przy kilku instruktorach pas jednej osoby nie zasłania dnia: klikalna jest tylko jego etykieta,
  // a puste miejsce dalej otwiera wpisanie lekcji.
  const bands = data.exceptions.filter((e) => e.date === day.date && e.end > range.start && e.start < range.end);
  const many = data.instructors.length > 1;
  const forSchool = data.isStaff || data.isInstructor;
  const clickable = Boolean(onEmpty) && !day.isPast;

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onEmpty || day.isPast) return;
    const top = event.currentTarget.getBoundingClientRect().top;
    const minutes = range.start + Math.floor((event.clientY - top) / PX_PER_MINUTE / SNAP_MINUTES) * SNAP_MINUTES;
    onEmpty(day.date, Math.min(minutes, range.end - SNAP_MINUTES));
  };

  return (
    <div
      className={`cal-day${day.isPast ? ' past' : ''}${day.isToday ? ' today' : ''}${clickable ? ' clickable' : ''}`}
      onClick={handleClick}
      aria-label={day.label}
    >
      {bands.map((band) => {
        const top = (Math.max(band.start, range.start) - range.start) * PX_PER_MINUTE;
        const bottom = (Math.min(band.end, range.end) - range.start) * PX_PER_MINUTE;
        const title = EXCEPTION_TITLES[band.kind];
        return (
          <button
            key={band.key}
            type="button"
            className={`cal-band ${band.kind}${many ? ' shared' : ''}`}
            style={{ top, height: Math.max(18, bottom - top) }}
            onClick={(event) => {
              event.stopPropagation();
              onException(band);
            }}
            aria-label={`${title}: ${band.periodLabel}, ${band.instructorName}${band.note ? `, ${band.note}` : ''}`}
          >
            <span className="cal-band-label">
              {title}
              {many ? ` · ${band.instructorName}` : ''}
              {band.note ? ` · ${band.note}` : ''}
            </span>
          </button>
        );
      })}
      {layoutDay(items).map(({ item, column, columns }) => {
        const style: CSSProperties = {
          top: (Math.max(item.start, range.start) - range.start) * PX_PER_MINUTE,
          height: Math.max(18, (Math.min(item.end, range.end) - Math.max(item.start, range.start)) * PX_PER_MINUTE - 2),
          left: `calc(${(column / columns) * 100}% + 2px)`,
          width: `calc(${100 / columns}% - 4px)`,
        };
        if (item.kind === 'slot') {
          const slot = item.slot;
          return (
            <button
              key={slot.key}
              type="button"
              className="cal-event slot"
              style={style}
              onClick={(event) => {
                event.stopPropagation();
                onSlot(slot);
              }}
              aria-label={`Wolny termin: ${slot.dateLabel}, ${slot.timeLabel}${many ? `, ${slot.instructorName}` : ''}`}
            >
              <span className="cal-event-time">{slot.timeLabel.slice(0, 5)}</span>
              <span className="cal-event-title">{many ? slot.instructorName : 'wolne'}</span>
            </button>
          );
        }
        const lesson = item.lesson;
        return (
          <button
            key={lesson.id}
            type="button"
            className={`cal-event lesson status-${lesson.status}`}
            style={style}
            onClick={(event) => {
              event.stopPropagation();
              onLesson(lesson);
            }}
            aria-label={`Lekcja: ${lesson.dateLabel}, ${lesson.timeLabel}, ${forSchool ? lesson.clientName : lesson.serviceName}, ${lesson.statusLabel}`}
          >
            <span className="cal-event-time">{lesson.timeLabel}</span>
            <span className="cal-event-title">{forSchool ? lesson.clientName : lesson.serviceName}</span>
            {lesson.status !== 'confirmed' ? <span className="cal-event-status">{lesson.statusLabel}</span> : null}
          </button>
        );
      })}
      {day.isToday && data.now.minutes >= range.start && data.now.minutes <= range.end ? (
        <div className="cal-now" style={{ top: (data.now.minutes - range.start) * PX_PER_MINUTE }} aria-hidden="true" />
      ) : null}
    </div>
  );
}

function AgendaList({ data, onSlot, onLesson, onException }: Handlers & { data: WeekData }) {
  const many = data.instructors.length > 1;
  const forSchool = data.isStaff || data.isInstructor;
  const days = data.days
    .map((day) => ({
      day,
      lessons: data.lessons.filter((l) => l.date === day.date),
      slots: data.slots.filter((s) => s.date === day.date),
      exceptions: data.exceptions.filter((e) => e.date === day.date),
    }))
    .filter((d) => d.lessons.length > 0 || d.slots.length > 0 || d.exceptions.length > 0);

  if (days.length === 0) {
    return (
      <p className="muted">
        {data.isInstructor ? 'W tym tygodniu nie masz lekcji.' : 'W tym tygodniu nie ma lekcji ani wolnych terminów.'}
      </p>
    );
  }

  return (
    <div className="agenda">
      {days.map(({ day, lessons, slots, exceptions }) => (
        <section key={day.date} className={`agenda-day${day.isToday ? ' today' : ''}`}>
          <h3>
            {day.label}
            {day.isToday ? <span className="badge">dziś</span> : null}
          </h3>
          {exceptions.length > 0 ? (
            <ul className="agenda-lessons">
              {exceptions.map((exception) => (
                <li key={exception.key}>
                  <button type="button" className={`agenda-band ${exception.kind}`} onClick={() => onException(exception)}>
                    <strong>{EXCEPTION_TITLES[exception.kind]}</strong>
                    <span>{exception.periodLabel}</span>
                    {many || exception.note ? (
                      <span className="muted small">
                        {[many ? exception.instructorName : null, exception.note].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {lessons.length > 0 ? (
            <ul className="agenda-lessons">
              {lessons.map((lesson) => (
                <li key={lesson.id}>
                  <button
                    type="button"
                    className={`agenda-lesson${lesson.blocksCalendar ? '' : ' inactive'}`}
                    onClick={() => onLesson(lesson)}
                  >
                    <strong>{lesson.timeLabel}</strong>
                    <span>{forSchool ? lesson.clientName : lesson.serviceName}</span>
                    <span className="muted small">
                      {many && !data.isInstructor ? `${lesson.instructorName} · ` : ''}
                      {lesson.statusLabel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {slots.length > 0 ? (
            <div className="agenda-slots">
              <span className="muted small">Wolne terminy:</span>
              {slots.map((slot) => (
                <button key={slot.key} type="button" className="slot-chip" onClick={() => onSlot(slot)}>
                  {slot.timeLabel.slice(0, 5)}
                  {many ? ` · ${slot.instructorName}` : ''}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
