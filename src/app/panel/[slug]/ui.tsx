'use client';
// Wspólne elementy panelu: okienko (dialog) z wynikiem akcji na miejscu i dymek z komunikatem na dole ekranu.
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';

/** Jak długo widać komunikat po akcji. */
const TOAST_MS = 6000;

export type Message = { kind: 'ok' | 'error'; text: string };

/** Komunikat po akcji: znika sam po kilku sekundach. */
export function useToast(): [Message | null, (message: Message | null) => void] {
  const [message, setMessage] = useState<Message | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return [message, setMessage];
}

/** Dymek na dole ekranu: nie przesuwa strony. */
export function Toast({ message, onHide }: { message: Message | null; onHide: () => void }) {
  return (
    <div className="toast-area" aria-live="polite">
      {message ? (
        <p className={`toast ${message.kind}`} role="status">
          {message.text}
          <button type="button" className="toast-close" onClick={onHide} aria-label="Ukryj komunikat">
            ✕
          </button>
        </p>
      ) : null}
    </div>
  );
}

type Result = { ok: true } | { ok: false; error: string };

/** Akcja serwera z okienka: w trakcie blokuje przyciski, a odmowę pokazuje w okienku. */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <R extends Result>(action: () => Promise<R>, onSuccess: (result: Extract<R, { ok: true }>) => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) onSuccess(result as Extract<R, { ok: true }>);
      else setError(result.error);
    });
  };
  return { pending, error, run };
}

/** Okienko nad stroną. Zamyka się przyciskiem „Zamknij”, klawiszem Esc albo kliknięciem w tło. */
export function Modal({
  onClose,
  pending,
  error,
  children,
}: {
  onClose: () => void;
  pending: boolean;
  error: string | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current && !pending) ref.current.close();
      }}
    >
      <div className="modal-body">
        {children}
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
