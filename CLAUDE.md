# Zasady projektu dla Claude

Projekt: rezerwacje lekcji indywidualnych (najpierw szkoła pierwszego tańca właściciela, docelowo produkt dla wielu firm).
Właściciel pisze w Javie; kod w TypeScript pisze głównie AI, a on pilnuje go przez testy i przegląd PR.

## Zanim zmienisz logikę

- Przeczytaj `docs/decyzje.md`. Gdy zmienia się decyzja, zaktualizuj ten plik w tym samym PR.
- Model danych opisuje `docs/model-danych.md`; źródłem prawdy jest SQL w `db/migrations`.

## Baza danych

- Każda nowa tabela z danymi firmy:
  - kolumna `organization_id`,
  - `UNIQUE (organization_id, id)`,
  - odwołania do innych tabel firmy przez złożony klucz `(organization_id, …)`,
  - `ENABLE ROW LEVEL SECURITY`, polityka `organization_id = current_org_id()` i uprawnienia dla `app_user`,
  - dopisz tabelę do testu „bez ustawionej firmy aplikacja nie widzi żadnych danych firm” w `db/tests/firmy.test.ts`.
- Aplikacja łączy się jako `app_user` (`APP_DATABASE_URL`). Dane firm czytaj i zmieniaj tylko przez `withTenant()` z `src/lib/db.ts`, które ustawia `app.organization_id` i `app.user_id` przez `set_config(…, true)`.
- Saldo lekcji to suma `credit_entries`. Nie dodawaj kolumny z saldem. Historii nie zmieniamy ani nie kasujemy: korekta to nowy wpis `adjustment` z notatką.
- Nakładanie rezerwacji blokuje `EXCLUDE` w `bookings`. Przed wstawieniem rezerwacji zmień w tej samej transakcji wygasłe blokady (`pending_payment` po `hold_expires_at`) na `expired`.
- Nowa zmiana schematu to nowy plik `db/migrations/NNNN_opis.sql`. Nie edytuj migracji, które trafiły już na serwer.
- Po każdej zmianie migracji uruchom `npm run db:types` i dołącz `src/lib/db-types.ts` do PR (CI sprawdza zgodność).
- Nic nie kasujemy fizycznie; używamy flagi `active` albo statusów. Wyjątek: tabele logowania `auth_*` (globalne, bez RLS).

## Aplikacja (Next.js)

- Strony wymagające logowania zaczynają od `requireUser()` z `src/lib/session.ts`.
- Komponenty z `'use client'` nie importują kodu serwera (`server.ts`, `auth.ts`, `db.ts`, `firms.ts`).
- Ustawienia tylko ze zmiennych środowiskowych przez `readConfig()`; nowe zmienne dopisz do `.env.example`.

## Testy

- Przed każdym commitem: `npm run db:up && npm test`, `npm run typecheck` i `npm run build`.
- Każda reguła biznesowa ma test nazwany jak reguła, po polsku, np. „nowy klient bez płatności nie zarezerwuje lekcji”.
- Testy bazy działają na prawdziwym PostgreSQL, nie na atrapach. Aplikację testuj rolą `app_user` (`appTestDatabaseUrl()`).

## Styl

- Identyfikatory po angielsku; komentarze, dokumentacja, komunikaty i interfejs po polsku.
- Małe PR, jeden etap z `docs/decyzje.md` na PR.
