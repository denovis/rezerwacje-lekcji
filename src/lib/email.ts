// Wysyłka maili.
// Lokalnie przez Mailpit (SMTP z docker-compose, podgląd na http://localhost:8025).
// Na serwerze przez dostawcę wybranego przed pierwszym wdrożeniem (też przez SMTP).
// Bez SMTP_URL mail trafia tylko do logu serwera.
import nodemailer from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (email: Email) => Promise<void>;

export function createMailer(options: { smtpUrl?: string | undefined; from: string }): SendEmail {
  if (!options.smtpUrl) {
    return async (email) => {
      console.info(`[mail do ${email.to}] ${email.subject}\n${email.text}`);
    };
  }
  const transport = nodemailer.createTransport(options.smtpUrl);
  return async (email) => {
    await transport.sendMail({ from: options.from, ...email });
  };
}

export function magicLinkEmail(to: string, url: string, minutes: number): Email {
  return {
    to,
    subject: 'Link do logowania',
    text: [
      'Dzień dobry,',
      '',
      'kliknij poniższy link, aby zalogować się do rezerwacji lekcji:',
      url,
      '',
      `Link działa przez ${minutes} minut i można go użyć tylko raz.`,
      'Jeśli to nie Ty prosisz o logowanie, zignoruj tę wiadomość.',
    ].join('\n'),
  };
}

// --- Maile z zadań w tle (etap 5b, src/lib/notifications.ts) ------------------------------------------
// Daty i kwoty przychodzą już sformatowane po polsku (format.ts), w czasie lokalnym firmy.

export interface LessonReminder {
  to: string;
  firmName: string;
  serviceName: string;
  /** Np. „piątek, 15 stycznia”. */
  day: string;
  /** Np. „16:00”. */
  start: string;
  end: string;
  instructorName: string;
  /** Do kiedy odwołanie zwraca lekcję, np. „14 stycznia, 16:00”; null, gdy ten czas już minął. */
  cancelUntil: string | null;
  calendarUrl: string;
}

export function lessonReminderEmail(r: LessonReminder): Email {
  return {
    to: r.to,
    subject: `Przypomnienie o lekcji: ${r.day}, ${r.start}`,
    text: [
      'Dzień dobry,',
      '',
      `${r.firmName} przypomina o Waszej lekcji:`,
      `${r.serviceName}, ${r.day}, ${r.start}–${r.end}`,
      `Instruktor: ${r.instructorName}`,
      '',
      r.cancelUntil
        ? `Jeśli nie możecie przyjść, odwołajcie lekcję w kalendarzu do ${r.cancelUntil}. Wtedy lekcja wróci na Wasze konto.`
        : 'Termin odwołania ze zwrotem lekcji już minął.',
      `Kalendarz i Wasze lekcje: ${r.calendarUrl}`,
      '',
      'Do zobaczenia!',
      r.firmName,
    ].join('\n'),
  };
}

export interface LatePaymentAlert {
  to: string;
  firmName: string;
  clientName: string;
  /** Np. „200,00 zł”. */
  amount: string;
  /** Termin lekcji, na którą była płatność, np. „15 stycznia, 16:00”; null przy pakiecie. */
  lesson: string | null;
  clientUrl: string;
}

export function latePaymentEmail(a: LatePaymentAlert): Email {
  return {
    to: a.to,
    subject: `Płatność po czasie: ${a.clientName}`,
    text: [
      'Dzień dobry,',
      '',
      `para ${a.clientName} zapłaciła online ${a.amount}${a.lesson ? ` za lekcję ${a.lesson}` : ''}, ale płatność dotarła po czasie i termin wrócił już do puli.`,
      'Lekcja jest na koncie pary do wykorzystania. Umówcie z parą nowy termin albo wpiszcie lekcję w kalendarzu, jeśli dawny termin jest jeszcze wolny.',
      '',
      `Para w panelu szkoły: ${a.clientUrl}`,
      '',
      `Wiadomość z rezerwacji lekcji: ${a.firmName}.`,
    ].join('\n'),
  };
}

export interface ClientRegisteredAlert {
  to: string;
  firmName: string;
  clientName: string;
  email: string | null;
  phone: string | null;
  /** Np. „19 czerwca 2027”; null, gdy para nie podała. */
  weddingDate: string | null;
  clientUrl: string;
}

export function clientRegisteredEmail(a: ClientRegisteredAlert): Email {
  return {
    to: a.to,
    subject: `Nowa para zapisała się: ${a.clientName}`,
    text: [
      'Dzień dobry,',
      '',
      'nowa para zapisała się sama na stronie zapisów szkoły:',
      a.clientName,
      `E-mail: ${a.email ?? 'brak'}`,
      `Telefon: ${a.phone ?? 'brak'}`,
      `Data ślubu: ${a.weddingDate ?? 'nie podano'}`,
      '',
      `Para ma status „nowa”. Para w panelu szkoły: ${a.clientUrl}`,
      '',
      `Wiadomość z rezerwacji lekcji: ${a.firmName}.`,
    ].join('\n'),
  };
}
