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
- Aplikacja zawsze łączy się jako `app_user` i w każdej transakcji ustawia `app.organization_id` i `app.user_id` przez `set_config(…, true)`.
- Saldo lekcji to suma `credit_entries`. Nie dodawaj kolumny z saldem. Historii nie zmieniamy ani nie kasujemy: korekta to nowy wpis `adjustment` z notatką.
- Nakładanie rezerwacji blokuje `EXCLUDE` w `bookings`. Przed wstawieniem rezerwacji zmień w tej samej transakcji wygasłe blokady (`pending_payment` po `hold_expires_at`) na `expired`.
- Nowa zmiana schematu to nowy plik `db/migrations/NNNN_opis.sql`. Nie edytuj migracji, które trafiły już na serwer.
- Nic nie kasujemy fizycznie; używamy flagi `active` albo statusów.

## Testy

- `npm run db:up && npm test` i `npm run typecheck` muszą przechodzić przed każdym commitem.
- Każda reguła biznesowa ma test nazwany jak reguła, po polsku, np. „nowy klient bez płatności nie zarezerwuje lekcji”.
- Testy bazy działają na prawdziwym PostgreSQL, nie na atrapach.

## Styl

- Identyfikatory po angielsku; komentarze, dokumentacja, komunikaty i interfejs po polsku.
- Małe PR, jeden etap z `docs/decyzje.md` na PR.
