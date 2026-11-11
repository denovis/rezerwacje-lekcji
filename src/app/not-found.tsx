import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="card">
      <h1>Nie ma takiej strony</h1>
      <p className="muted">Adres jest błędny albo nie masz dostępu do tej firmy.</p>
      <Link href="/panel">Wróć do swoich firm</Link>
    </main>
  );
}
