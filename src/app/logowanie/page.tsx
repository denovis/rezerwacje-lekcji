import { MAGIC_LINK_MINUTES } from '../../lib/auth';
import { LoginForm } from './login-form';

export const metadata = { title: 'Logowanie · Rezerwacje lekcji' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="card">
      <h1>Logowanie</h1>
      <p className="muted">Wpisz swój adres e-mail. Wyślemy na niego link, który zaloguje Cię bez hasła.</p>
      {error ? (
        <p className="alert" role="alert">
          Ten link wygasł albo został już użyty. Wyślij nowy.
        </p>
      ) : null}
      <LoginForm minutes={MAGIC_LINK_MINUTES} />
    </main>
  );
}
