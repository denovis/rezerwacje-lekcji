'use client';

import { useState, type FormEvent } from 'react';
import { authClient } from '../../lib/auth-client';

type State = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Prośba o link z maila. Ten sam formularz loguje i przy pierwszym logowaniu zakłada konto,
 * więc służy też na stronie zapisów nowej pary (wtedy link prowadzi z powrotem na tę stronę).
 */
export function LoginForm({
  minutes,
  callbackURL = '/panel',
  errorCallbackURL = '/logowanie',
  submitLabel = 'Wyślij link do logowania',
  afterSent = null,
}: {
  minutes: number;
  /** Dokąd prowadzi link z maila. */
  callbackURL?: string;
  /** Dokąd prowadzi link, który wygasł albo został już użyty (z parametrem ?error=…). */
  errorCallbackURL?: string;
  submitLabel?: string;
  /** Co się stanie po kliknięciu linku (dopisane po informacji o wysłaniu). */
  afterSent?: string | null;
}) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>('idle');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('sending');
    const { error } = await authClient.signIn.magicLink({ email, callbackURL, errorCallbackURL });
    setState(error ? 'error' : 'sent');
  }

  if (state === 'sent') {
    return (
      <div role="status">
        <p>
          Wysłaliśmy link na adres <strong>{email}</strong>. Otwórz maila i kliknij link — działa przez {minutes} minut.
          {afterSent ? ` ${afterSent}` : null}
        </p>
        <button type="button" className="secondary" onClick={() => setState('idle')}>
          Wpisz inny adres
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="email">Adres e-mail</label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? 'Wysyłam…' : submitLabel}
      </button>
      {state === 'error' ? (
        <p className="alert" role="alert">
          Nie udało się wysłać linku. Spróbuj ponownie za chwilę.
        </p>
      ) : null}
    </form>
  );
}
