# Rezerwacje lekcji

Rezerwacje lekcji indywidualnych z pakietami lekcji, płatnością online (BLIK, karta, Przelewy24 przez Stripe) i gotówką wpisywaną przez admina. Najpierw dla jednej szkoły pierwszego tańca, z bazą gotową na wiele firm.

- [Plan prac](docs/plan.md): etapy, co jest gotowe, co zaplanowane i pomysły na później.
- [Decyzje projektu](docs/decyzje.md): co budujemy i jakie są zasady.
- [Model danych](docs/model-danych.md): tabele, reguły pilnowane przez bazę, sposób łączenia się aplikacji.

Wymagania: Node.js 22.12+ (najlepiej LTS 22 albo 24) i Docker z Compose v2.

## Uruchomienie aplikacji na komputerze

```bash
cp .env.example .env
npm install
npm run db:up                       # PostgreSQL 16 i skrzynka testowa Mailpit w Dockerze
npm run db:migrate                  # zakłada bazę i stosuje migracje
npm run db:app-login                # pozwala aplikacji logować się rolą app_user
npm run db:seed -- twoj@adres.pl    # szkoła z Tobą jako właścicielem, instruktor i para klientów
npm run dev                         # http://localhost:3000
```

Logowanie: wpisz adres podany w `db:seed`. Mail z linkiem nie wychodzi na zewnątrz, tylko trafia do Mailpit na http://localhost:8025.

Dane startowe zakładają też instruktora z godzinami pracy pon–pt 16:00–21:00 i parę klientów `para@example.com` z 5 lekcjami na koncie. Zaloguj się adresem pary, żeby zarezerwować i odwołać lekcję. Inny adres pary: `npm run db:seed -- twoj@adres.pl para@adres.pl`.

Instruktorów, godziny pracy, urlopy, reguły grafiku i usługi zmienia właściciel w panelu: przycisk „Ustawienia grafiku” nad kalendarzem. Żeby zobaczyć kalendarz instruktora, wpisz tam przy instruktorze dowolny adres (np. `instruktor@example.com`) i zaloguj się nim.

Pary, ich status, historię lekcji, korekty salda i osoby na minusie właściciel prowadzi na stronie „Klienci” (przycisk obok „Ustawienia grafiku”). Nieobecność oznacza się w okienku lekcji w kalendarzu.

## Testy

```bash
npm run db:up      # jeśli baza jeszcze nie działa
npm test           # tworzy bazę rezerwacje_test, stosuje migracje i uruchamia testy
npm run typecheck
npm run build
```

Te same kroki uruchamiają się na GitHubie przy każdym PR (`.github/workflows/testy.yml`).

Inny serwer PostgreSQL do testów: ustaw `TEST_DATABASE_ADMIN_URL`, np. `postgres://postgres:haslo@localhost:5432/postgres`.

Po zmianie migracji: `npm run db:migrate && npm run db:types` (typy tabel dla TypeScriptu).

## Struktura

```
db/migrations/   migracje SQL (źródło prawdy dla modelu danych)
db/*.ts          migracje, hasło roli app_user, dane startowe
db/tests/        testy reguł pilnowanych przez bazę
src/app/         strony Next.js: logowanie, wybór firmy, panel z kalendarzem tygodniowym
src/lib/         baza (withTenant), logowanie, maile, ustawienia, wolne terminy (slots),
                 rezerwacje i odwołania (bookings), dane kalendarza (week) + testy
docs/            decyzje i model danych
```
