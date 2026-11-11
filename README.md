# Rezerwacje lekcji

Rezerwacje lekcji indywidualnych z pakietami lekcji, płatnością online (BLIK, karta, Przelewy24 przez Stripe) i gotówką wpisywaną przez admina. Najpierw dla jednej szkoły pierwszego tańca, z bazą gotową na wiele firm.

- [Decyzje projektu](docs/decyzje.md): co budujemy, zasady i kolejne etapy.
- [Model danych](docs/model-danych.md): tabele, reguły pilnowane przez bazę, sposób łączenia się aplikacji.

## Uruchomienie testów

Wymagania: Node.js 22.12+ (najlepiej LTS 22 albo 24) i Docker z Compose v2.

```bash
npm install
npm run db:up      # PostgreSQL 16 w Dockerze, port 5433; czeka, aż baza będzie gotowa
npm test           # tworzy bazę rezerwacje_test, stosuje migracje i uruchamia testy
npm run typecheck
```

Inny serwer PostgreSQL: ustaw `TEST_DATABASE_ADMIN_URL`, np. `postgres://postgres:haslo@localhost:5432/postgres`.

Migracje na zwykłej bazie: `DATABASE_URL=postgres://… npm run db:migrate`.

## Struktura

```
db/migrations/   migracje SQL (źródło prawdy dla modelu danych)
db/migrate.ts    uruchamianie migracji
db/tests/        testy reguł pilnowanych przez bazę
docs/            decyzje i model danych
```
