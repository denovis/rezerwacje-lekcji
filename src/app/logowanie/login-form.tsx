'use client';

import { useState, type FormEvent } from 'react';
import { authClient } from '../../lib/auth-client';

type State = 'idle' | 'sending' | 'sent' | 'error';

export function LoginForm({ minutes }: { minutes: number }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>('idle');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('sending');
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: '/panel',
      errorCallbackURL: '/logowanie',
    });
    setState(error ? 'error' : 'sent');
  }

  if (state === 'sent') {
    return (
      <div role="status">
        <p>
          Wysłaliśmy link na adres <strong>{email}</strong>. Otwórz maila i kliknij link — działa przez {minutes} minut.
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
        {state === 'sending' ? 'Wysyłam…' : 'Wyślij link do logowania'}
      </button>
      {state === 'error' ? (
        <p className="alert" role="alert">
          Nie udało się wysłać linku. Spróbuj ponownie za chwilę.
        </p>
      ) : null}
    </form>
  );
}
