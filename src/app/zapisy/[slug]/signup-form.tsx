'use client';
// Dane nowej pary na stronie zapisów (para jest już zalogowana linkiem z maila).
import { useState, useTransition, type FormEvent } from 'react';
import { signUpAction } from './actions';

export function SignUpForm({ slug }: { slug: string }) {
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      // Po udanym zapisie akcja przenosi do kalendarza; wraca tylko z odmową.
      const result = await signUpAction({ slug, displayName, phone, targetDate });
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="stack-form">
      <label htmlFor="displayName">Nazwa pary</label>
      <input
        id="displayName"
        type="text"
        required
        maxLength={80}
        placeholder="np. Anna i Piotr"
        autoComplete="name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <label htmlFor="phone">Telefon</label>
      <input
        id="phone"
        type="tel"
        required
        maxLength={40}
        autoComplete="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <label htmlFor="targetDate">
        Data ślubu <span className="muted small field-optional">(jeśli już wiecie)</span>
      </label>
      <input id="targetDate" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
      <button type="submit" disabled={pending}>
        {pending ? 'Zapisuję…' : 'Zapisz nas'}
      </button>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
