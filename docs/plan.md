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

### Pierwsze wdrożenie (po etapie 3)

- [ ] Wybór hostingu aplikacji i bazy, dostawcy maili i domeny szkoły ([decyzje.md](decyzje.md), „Technologia”).

### Etap 4. Płatności: zaplanowane

- [ ] Stripe Checkout: BLIK, karta, Przelewy24.
- [ ] Pierwsza lekcja nowej pary: termin czeka na płatność, a nieopłacony wraca do puli.
- [ ] Kupno pakietu lekcji online.
- [ ] Webhook Stripe: płatność dopisuje lekcje na konto (najwyżej raz).
- [ ] Gotówka w panelu: kto przyjął, ile zł, ile lekcji.
- [ ] Samodzielna rejestracja nowej pary na stronie szkoły (wcześniej bez etapu; pasuje tutaj, bo nowa para płaci za pierwszą lekcję online).
- [ ] W ustawieniach: cena pojedynczej lekcji w usłudze i czas blokady terminu na płatność (`payment_hold_minutes`) (dopisane w etapie 3b).

### Etap 5. Przypomnienia i zadania w tle: zaplanowane

- [ ] Przypomnienie mailem przed lekcją.
- [ ] Wygasanie blokad terminu na czas płatności.
- [ ] Lekcja po swoim końcu zmienia się na „odbytą”.
- [ ] Para po pierwszej odbytej lekcji staje się stała.
- [ ] W ustawieniach: kiedy wysłać przypomnienie i włączanie automatycznych zmian statusów (`reminder_hours_before`, `auto_complete_lessons`, `auto_promote_after_first_lesson`) (dopisane w etapie 3b).

## Na później (po wersji 1)

- **Przesuwanie lekcji przeciąganiem** (zgłoszone 11.11.2026): kafelek lekcji w kalendarzu przeciągasz w inne miejsce i lekcja zmienia termin. Do ustalenia: czy para też może przesuwać swoje lekcje, czy wolno przesunąć lekcję po terminie odwołania i czy przesunięcie liczy się do limitu przełożeń.
- Lista rezerwowa i otwieranie grafiku partiami.
- Limit przełożeń na pakiet, ostrzeżenia po późnych odwołaniach, automatyczna utrata statusu zaufanego, potwierdzanie lekcji.
- Ważność pakietów.
- SMS, synchronizacja z Google Calendar, vouchery, eksport do Excela albo na endpoint.
- Nadpisywanie reguł grafiku dla instruktora albo usługi.
- Dostęp do panelu (zauważone w etapie 3b): dodawanie administratorów i odbieranie roli. Wyłączony instruktor albo instruktor bez adresu e-mail zachowuje rolę w firmie, ale nie widzi już żadnych lekcji.
- Klienci (zauważone w etapie 3c): dodanie nowej pary prosto z okienka „Nowa lekcja” w kalendarzu; oznaczanie nieobecności przez instruktora na jego lekcjach; ukrywanie par, które skończyły kurs (tabela `clients` nie ma jeszcze flagi `active`).
- Godziny pracy instruktorów w tle kalendarza szkoły (np. szare tło poza godzinami pracy) i zaznaczanie wolnego przeciągnięciem po siatce.
- Stripe Connect i zakładanie firm przez stronę.
- Do sprawdzenia przed sprzedażą:
  - z księgową: paragony i kasa fiskalna, zwłaszcza przy gotówce;
  - RODO: umowa powierzenia przetwarzania danych z każdą firmą.
