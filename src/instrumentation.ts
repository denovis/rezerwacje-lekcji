// Next.js wywołuje register() raz przy starcie serwera aplikacji (npm run dev, npm start).
// Uruchamiamy tu zadania w tle (src/lib/background.ts): wygasanie blokad terminu, lekcje odbyte, awans pary.
// Gdy aplikacja nie działa (np. wyłączony komputer), zadania czekają i nadrabiają zaległości po starcie.
export async function register(): Promise<void> {
  // Tylko serwer Node.js, nie budowanie aplikacji (npm run build) ani środowisko edge.
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  try {
    const { server } = await import('./lib/server');
    const { startBackgroundTasks } = await import('./lib/background');
    startBackgroundTasks(server().db);
  } catch (err) {
    // Np. brak ustawień w .env: aplikacja i tak pokaże błąd przy pierwszej stronie, a serwer ma wystartować.
    console.error('[zadania w tle] Nie wystartowały:', err);
  }
}
