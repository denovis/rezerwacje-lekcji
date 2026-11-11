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
