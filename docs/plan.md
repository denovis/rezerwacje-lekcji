# Plan prac

Jedna lista wszystkiego, co jest do zrobienia: etapy wersji 1 i pomysły na później.
Masz pomysł albo czegoś brakuje? Sprawdź tutaj. Jeśli tego nie ma, zgłoś, a dopiszemy to do właściwego etapu albo do „Na później”.
Jak aplikacja ma działać (zasady, reguły, technologia), opisuje [decyzje.md](decyzje.md).

Każdy etap to osobny PR. Gdy etap jest gotowy, zaznaczamy go tutaj w tym samym PR.

## Wersja 1

### Etap 1. Model danych: gotowe (PR #1)

- [x] Decyzje, tabele w SQL i testy bazy: saldo jako historia wpisów, rezerwacje bez nakładania się, wiele firm w jednej bazie.

### Etap 2. Szkielet aplikacji: gotowe (PR #2)

- [x] Logowanie linkiem z maila, wybór firmy, połączenie z bazą jako `app_user`, testy na GitHubie.

### Etap 3a. Kalendarz i rezerwacje: gotowe (PR #3)

- [x] Wolne terminy z reguł grafiku: lekcje jedna po drugiej, przyklejone do rezerwacji (bez dziur przed nią i po niej).
- [x] Rezerwacja z kontrolą salda i limitu; odwołanie ze zwrotem lekcji do terminu odwołania.
- [x] Kalendarz tygodniowy: siatka godzin jak w Google Calendar albo lista dni.
- [x] Para rezerwuje i odwołuje kliknięciem w kalendarzu.
- [x] Szkoła wpisuje lekcję dla klienta, także o dowolnej godzinie.
- [x] Commit i PR.

### Etap 3b. Ustawienia grafiku w panelu szkoły: gotowe (PR #4)

Strona „Ustawienia grafiku” (przycisk nad kalendarzem); wolne i dodatkowe godziny także prosto w kalendarzu.

- [x] Instruktorzy: dodawanie, zmiana nazwy, wyłączanie; adres e-mail, którym instruktor loguje się do swojego kalendarza.
- [x] Stałe godziny pracy instruktora, zmieniane od wybranego dnia.
- [x] Wyjątki: urlop, wolne, dodatkowe godziny (w kalendarzu: kliknięcie w puste miejsce, szary pas wolnego).
- [x] Reguły grafiku (przerwa, wyprzedzenie, horyzont, termin odwołania…) i usługi (nazwa, długość, ile lekcji zdejmuje).
- [x] Kalendarz instruktora: podgląd jego lekcji.
- [x] Commit i PR.

### Etap 3c. Klienci w panelu szkoły: gotowe (PR #5)

Strona „Klienci” (przycisk nad kalendarzem); nieobecność w okienku lekcji w kalendarzu.

- [x] Dodawanie pary (nazwa, e-mail, telefon, data ślubu, notatki); para loguje się potem tym adresem.
- [x] Zmiana statusu klienta (nowy, stały, zaufany) i limitu zejścia poniżej zera.
- [x] Historia lekcji klienta i ręczna korekta salda z notatką.
- [x] Lista osób na minusie.
- [x] Oznaczanie nieobecności (i cofanie pomyłki).
- [x] Domyślny limit zaufanego klienta (`default_trusted_credit_limit`) w ustawieniach grafiku, w części „Klienci”.
- [x] Commit i PR.

### Pierwsze wdrożenie: odłożone (decyzja 12.11.2026)

- [x] Decyzja ([decyzje.md](decyzje.md), „Technologia”): na razie aplikacja działa lokalnie; maile przez Brevo; na start bez domeny.
- [ ] Wdrożenie na serwer (polecany Render, Frankfurt), gdy aplikacja ma działać dla par przez internet.
- [ ] Zanim pary dostaną link do zapisów: na stronie zapisów informacja RODO (kto przetwarza dane i po co) i akceptacja regulaminu szkoły. Treść ustala właściciel (dopisane w etapie 4c; dziś strona zapisów zbiera dane bez takiej informacji).

### Etap 4a. Ceny, pakiety i gotówka: gotowe (PR #6)

Etap 4 podzielony 12.11.2026 na trzy PR-y; 4a nie wymaga konta Stripe.

- [x] W ustawieniach: cena pojedynczej lekcji w usłudze.
- [x] Pakiety lekcji w ustawieniach: nazwa, liczba lekcji, cena; wyłączanie.
- [x] Gotówka w panelu: kto przyjął, ile zł, ile lekcji (pakiet albo pojedyncze lekcje).
- [x] Strona „Ustawienia grafiku” nazywa się teraz „Ustawienia” (są tam też ceny i pakiety).
- [x] Commit i PR.

### Etap 4b. Płatności online (Stripe): gotowe (PR #7)

Wymaga konta Stripe w trybie testowym (zakłada właściciel).

- [x] Stripe Checkout: BLIK, karta, Przelewy24.
- [x] Pierwsza lekcja nowej pary: termin czeka na płatność, a nieopłacony wraca do puli; para może dokończyć płatność albo zrezygnować.
- [x] Kupno pakietu lekcji online.
- [x] Webhook Stripe: płatność dopisuje lekcje na konto (najwyżej raz); to samo sprawdzenie przy powrocie ze strony płatności.
- [x] W ustawieniach: czas blokady terminu na płatność (`payment_hold_minutes`) (dopisane w etapie 3b).
- [x] Commit i PR.

### Etap 4c. Samodzielna rejestracja nowej pary: gotowe (PR #8)

Strona zapisów szkoły `/zapisy/<adres szkoły>`; link do niej szkoła ma na stronie Klienci.

- [x] Samodzielna rejestracja nowej pary na stronie szkoły (wcześniej bez etapu; pasuje po 4b, bo nowa para płaci za pierwszą lekcję online).
- [x] Najpierw adres e-mail i link z maila, potem dane pary (nazwa, telefon, data ślubu); po zapisie para trafia prosto do kalendarza.
- [x] Bez dubli: para z profilem w szkole od razu trafia do kalendarza; osoba z rolą w szkole nie zapisuje się jako para.
- [x] Na stronie Klienci: link do zapisów z przyciskiem „Kopiuj link”.
- [x] Commit i PR.

Etap 5 podzielony 13.11.2026 na dwa PR-y: 5a zmienia statusy w tle (bez maili), 5b wysyła maile.

### Etap 5a. Zadania w tle: gotowe (PR #9)

Serwer aplikacji co minutę sprawdza wszystkie firmy, a po starcie od razu nadrabia to, co wypadło, gdy aplikacja nie działała.

- [x] Wygasanie blokad terminu na czas płatności.
- [x] Lekcja po swoim końcu zmienia się na „odbytą”.
- [x] Para po pierwszej odbytej lekcji staje się stała.
- [x] W ustawieniach: włączanie automatycznych zmian statusów (`auto_complete_lessons`, `auto_promote_after_first_lesson`) (dopisane w etapie 3b).
- [x] Commit i PR.

### Etap 5b. Maile: gotowe (PR #10)

Wymaga etapu 5a (maile wysyłają zadania w tle).

- [x] Przypomnienie mailem przed lekcją.
- [x] W ustawieniach: kiedy wysłać przypomnienie (`reminder_hours_before`) (dopisane w etapie 3b).
- [x] Alert dla szkoły o płatności, która dotarła po zwolnieniu terminu (mail do właścicieli i administratorów) (dopisane w etapie 4b).
- [x] Mail do szkoły o nowej parze, która zapisała się sama (dopisane w etapie 4c).
- [x] Commit i PR.

## Na później (po wersji 1)

- **Przesuwanie lekcji przeciąganiem** (zgłoszone 11.11.2026): kafelek lekcji w kalendarzu przeciągasz w inne miejsce i lekcja zmienia termin. Do ustalenia: czy para też może przesuwać swoje lekcje, czy wolno przesunąć lekcję po terminie odwołania i czy przesunięcie liczy się do limitu przełożeń.
- Lista rezerwowa i otwieranie grafiku partiami.
- Limit przełożeń na pakiet, ostrzeżenia po późnych odwołaniach, automatyczna utrata statusu zaufanego, potwierdzanie lekcji.
- Ważność pakietów.
- SMS, synchronizacja z Google Calendar, vouchery, eksport do Excela albo na endpoint.
- Nadpisywanie reguł grafiku dla instruktora albo usługi.
- Dostęp do panelu (zauważone w etapie 3b): dodawanie administratorów i odbieranie roli. Wyłączony instruktor albo instruktor bez adresu e-mail zachowuje rolę w firmie, ale nie widzi już żadnych lekcji.
- Klienci (zauważone w etapie 3c): dodanie nowej pary prosto z okienka „Nowa lekcja” w kalendarzu; oznaczanie nieobecności przez instruktora na jego lekcjach; ukrywanie par, które skończyły kurs (tabela `clients` nie ma jeszcze flagi `active`).
- Zapisy nowych par (zauważone w etapie 4c): wyłącznik zapisów w ustawieniach szkoły (dziś każda szkoła ma stronę zapisów); łączenie dwóch profili tej samej pary, np. dodanej przez szkołę bez adresu e-mail, która potem zapisała się sama.
- Godziny pracy instruktorów w tle kalendarza szkoły (np. szare tło poza godzinami pracy) i zaznaczanie wolnego przeciągnięciem po siatce.
- Stripe Connect i zakładanie firm przez stronę.
- Do sprawdzenia przed sprzedażą:
  - z księgową: paragony i kasa fiskalna, zwłaszcza przy gotówce;
  - RODO: umowa powierzenia przetwarzania danych z każdą firmą.
