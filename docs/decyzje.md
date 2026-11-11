# Decyzje projektu

Wersja 0.1 z 11.11.2026. To żywy dokument: gdy zmienia się decyzja, zmieniamy ją tutaj w tym samym PR co kod.

## 1. Produkt

- **Co budujemy:** rezerwacje lekcji indywidualnych z pakietami lekcji, płatnością online (BLIK, karta, Przelewy24 przez Stripe) i gotówką wpisywaną przez admina.
- **Pierwszy klient:** własna szkoła pierwszego tańca. Lekcje są indywidualne, klientem jest para, bez MultiSportu.
- **Docelowo:** sprzedaż innym, np. szkołom pierwszego tańca i trenerom personalnym. Działa trochę jak Booksy, ale bez platformy, przez którą klienci szukają firm.
- **Konkurencja (stan na 11.2026):**
  - WodGuru: lekcje 1:1, pakiety, BLIK; 5 zł za klienta miesięcznie, maksymalnie 499 zł netto.
  - Fitssey: lekcje 1:1, synchronizacja kalendarzy.
  - Booksy: 145 zł netto miesięcznie, przedpłaty i kaucje, platforma z klientami.
- **Gdzie szukamy przewagi:** w regułach na dziury w grafiku i na ciągłe odwołania. Każda firma ustawia je u siebie.

## 2. Zasady biznesowe

### Statusy klientów

| Status | Jak klient go dostaje | Co może |
|---|---|---|
| `new` (nowy) | przy rejestracji | rezerwuje pierwszą lekcję tylko z płatnością online od razu |
| `regular` (stały) | automatycznie po pierwszej odbytej lekcji (ustawienie `auto_promote_after_first_lesson`) | rezerwuje, gdy ma lekcje na koncie, opłacone online albo gotówką dopisaną przez admina |
| `trusted` (zaufany) | ręcznie przez admina | rezerwuje także bez lekcji na koncie, do limitu `credit_limit`, i płaci gotówką na miejscu |

- Limit to jedna liczba: o ile saldo może zejść poniżej zera. Nowy i stały mają 0, zaufany domyślnie `default_trusted_credit_limit`.
- Baza nie pozwala ustawić limitu większego od 0 komuś, kto nie jest zaufany.
- Rezerwacja przechodzi, jeśli po zdjęciu lekcji saldo ≥ −limit. Sprawdza to aplikacja w transakcji z blokadą wiersza klienta (etap 3).

### Saldo lekcji to historia wpisów

- Saldo nie jest zapisaną liczbą, tylko sumą wpisów w `credit_entries`:
  - `purchase` +N za płatność online albo gotówkową,
  - `booking` −koszt przy rezerwacji,
  - `booking_refund` +koszt przy odwołaniu w terminie,
  - `adjustment` ±N, ręczna korekta admina, zawsze z autorem i notatką.
- Historię można tylko dopisywać. Aplikacja nie ma uprawnień do zmiany ani usuwania wpisów.
- Jedna płatność dopisuje lekcje najwyżej raz, a jedna rezerwacja zdejmuje lekcję raz i zwraca ją najwyżej raz. Pilnuje tego baza (unikalne indeksy), więc powtórzony webhook ze Stripe nic nie zepsuje.

### Płatności

- **Pierwsza lekcja nowego klienta:**
  - rezerwacja dostaje status `pending_payment` i trzyma termin;
  - sesja Stripe Checkout wygasa po `payment_hold_minutes`, co najmniej 30 minut, bo tyle wynosi minimum `expires_at` w Stripe;
  - zdarzenie `checkout.session.expired` zmienia rezerwację na `expired` i termin wraca do puli;
  - płatność, która dotrze po zwolnieniu terminu, trafia na konto klienta jako lekcja do wykorzystania, a admin dostaje alert.
- **Gotówka:** admin wpisuje płatność (kto przyjął, ile zł, ile lekcji), co daje wpis +N w historii.
- **Konto Stripe:** na razie główne konto Damiana, więc `organizations.stripe_account_id` = NULL. Stripe Connect włączymy później na tym samym koncie jako platformie. Jego szkoła dalej przyjmuje płatności na to konto, a kolejne firmy podłączają własne konta.

### Odwołania

- Do `cancel_deadline_hours` przed lekcją: status `cancelled` i lekcja wraca na konto.
- Po tym terminie: status `late_cancelled` i lekcja przepada.
- Nieobecność: status `no_show` i lekcja przepada.
- Lekcja sama zmienia się na `completed` po swoim końcu (ustawienie `auto_complete_lessons`), chyba że admin oznaczy nieobecność.

### Reguły grafiku (ustawienia firmy w `organization_settings`)

| Ustawienie | Domyślnie | Co robi |
|---|---|---|
| `slot_step_minutes` | 30 | co ile minut może zacząć się lekcja |
| `buffer_minutes` | 0 | przerwa po każdej lekcji; blokuje kalendarz |
| `min_gap_minutes` | 0 (wyłączone) | nie pokazuje terminów, które zostawiłyby przerwę krótszą niż ta wartość |
| `compact_days` | nie | „przyklejanie”: gdy dzień ma rezerwację, pokazuje tylko terminy tuż obok niej |
| `min_notice_minutes` | 1440 (24 h) | najkrótsze wyprzedzenie rezerwacji |
| `max_advance_days` | 60 | jak daleko do przodu można rezerwować |
| `cancel_deadline_hours` | 24 | do kiedy odwołanie zwraca lekcję |
| `reminder_hours_before` | 24 | kiedy wysłać przypomnienie |
| `first_lesson_prepaid` | tak | pierwsza lekcja nowego klienta tylko z płatnością online |
| `payment_hold_minutes` | 30 | jak długo termin czeka na płatność (30 min – 24 h) |

Przykład dla `min_gap_minutes` = 60 (sprawdzony skryptem):
- okno 16:00–21:00, lekcje po 60 minut, start co 30 minut, rezerwacja 18:00–19:00;
- znikają 16:30 i 19:30, bo każdy z tych terminów zostawiłby po 30 minut z obu stron;
- zostają 16:00, 17:00, 19:00 i 20:00.

### Na później (poza wersją 1)

- Lista rezerwowa i otwieranie grafiku partiami.
- Limit przełożeń na pakiet, ostrzeżenia po późnych odwołaniach, automatyczna utrata statusu zaufanego, potwierdzanie lekcji.
- Ważność pakietów.
- SMS, synchronizacja z Google Calendar, vouchery, eksport do Excela albo na endpoint.
- Nadpisywanie reguł dla instruktora albo usługi.
- Stripe Connect i zakładanie firm przez stronę.
- Do sprawdzenia przed sprzedażą:
  - z księgową: paragony i kasa fiskalna, zwłaszcza przy gotówce;
  - RODO: umowa powierzenia przetwarzania danych z każdą firmą.

## 3. Technologia

- **Język i baza:** TypeScript i Next.js (aplikacja od etapu 2), PostgreSQL 16.
- **Najpierw baza:** migracje SQL w `db/migrations` są źródłem prawdy, a uruchamia je `db/migrate.ts`. Warstwę zapytań wybieramy przy szkielecie aplikacji, np. Drizzle z odczytem schematu z bazy.
- **Testy:** Vitest na prawdziwym PostgreSQL (`docker compose`). Każda reguła biznesowa ma test nazwany jak reguła, po polsku. Kod pisze głównie AI, więc testy są głównym narzędziem kontroli.
- **Język w kodzie:** identyfikatory po angielsku; komentarze, dokumentacja i interfejs po polsku.
- **Do wyboru w etapie 2:**
  - biblioteka logowania (logowanie linkiem z maila),
  - dostawca maili,
  - hosting.

## 4. Wiele firm w jednej bazie

- Każda tabela z danymi firmy ma `organization_id`.
- Odwołania między takimi tabelami idą przez złożony klucz `(organization_id, id)`. Rezerwacja z firmy A nie może więc wskazać instruktora ani klienta z firmy B, nawet przy błędzie w kodzie.
- **Row-level security:**
  - aplikacja łączy się rolą `app_user`;
  - na początku każdej transakcji ustawia `set_config('app.organization_id', …, true)` i `app.user_id`;
  - bez ustawionej firmy nie widzi żadnych danych firm.
- **Konta:** `users` to konto logowania wspólne dla całego systemu. Rola w firmie siedzi w `memberships` (właściciel, admin, instruktor). Klient to osobny rekord w `clients`, z kontem albo bez.
- **Co widzi zalogowany użytkownik:** swoje członkostwa i profile klienta we wszystkich firmach, ale tylko do odczytu. Dzięki temu po zalogowaniu wybiera firmę.
- **Tabela `organizations`:** można ją czytać bez kontekstu (publiczna strona rezerwacji po adresie). Nowe firmy zakłada platforma, nie aplikacja.
- **Nic nie kasujemy:** instruktorzy, usługi i pakiety mają flagę `active`, a historia płatności i lekcji zostaje.
- **Czas:**
  - rezerwacje są zapisane jako `timestamptz`;
  - stałe godziny pracy są w czasie lokalnym firmy (`organizations.timezone`, domyślnie Europe/Warsaw);
  - przeliczenie robi aplikacja, z uwzględnieniem zmiany czasu w marcu i październiku.

## 5. Zakres wersji 1

1. Konta par i logowanie linkiem z maila; role: admin, instruktor, klient.
2. Dostępność instruktora i rezerwacja przez klienta, z regułą minimalnej przerwy i wyprzedzenia.
3. Pierwsza lekcja płatna online (BLIK, karta, Przelewy24), z blokadą terminu na czas płatności.
4. Saldo lekcji jako historia wpisów i statusy klienta: nowy, stały, zaufany z limitem.
5. Panel admina: dopisanie gotówki, zmiana statusu klienta, lista osób na minusie, oznaczanie nieobecności.
6. Odwoływanie z terminem z ustawień i przypomnienie mailem dzień przed.

## 6. Etapy

1. **Ten PR:** decyzje, model danych (migracja SQL) i testy bazy.
2. Szkielet Next.js, logowanie, wybór firmy, połączenie z bazą jako `app_user`.
3. Kalendarz i rezerwacje. Wyliczanie wolnych terminów to czysta funkcja: dostępność minus rezerwacje i przerwy, potem siatka startów i reguły. Do tego testy każdej reguły, rezerwacja i odwołanie z historią lekcji.
4. Płatności: Stripe Checkout, webhook, gotówka w panelu.
5. Przypomnienia i zadania w tle: wygasanie blokad, oznaczanie lekcji jako odbytych, przejście klienta z nowego na stałego.
