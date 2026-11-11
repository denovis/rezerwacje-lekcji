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

### Etap 3a. Kalendarz i rezerwacje: w trakcie

- [x] Wolne terminy z reguł grafiku: lekcje jedna po drugiej, przyklejone do rezerwacji (bez dziur przed nią i po niej).
- [x] Rezerwacja z kontrolą salda i limitu; odwołanie ze zwrotem lekcji do terminu odwołania.
- [x] Kalendarz tygodniowy: siatka godzin jak w Google Calendar albo lista dni.
- [x] Para rezerwuje i odwołuje kliknięciem w kalendarzu.
- [x] Szkoła wpisuje lekcję dla klienta, także o dowolnej godzinie.
- [ ] Commit i PR.

### Etap 3b. Ustawienia grafiku w panelu szkoły: zaplanowane

Do tego czasu te dane wpisuje `npm run db:seed` albo SQL.

- [ ] Instruktorzy: dodawanie i wyłączanie.
- [ ] Stałe godziny pracy instruktora.
- [ ] Wyjątki: urlop, wolne, dodatkowe godziny.
- [ ] Reguły grafiku (przerwa, wyprzedzenie, horyzont, termin odwołania…) i usługi (rodzaj i długość lekcji).
- [ ] Kalendarz instruktora: podgląd jego lekcji.

### Etap 3c. Klienci w panelu szkoły: zaplanowane

Te punkty są w zakresie wersji 1 (panel admina), ale wcześniej nie miały etapu.

- [ ] Dodawanie pary (nazwa, e-mail); para loguje się potem tym adresem.
- [ ] Zmiana statusu klienta (nowy, stały, zaufany) i limitu zejścia poniżej zera.
- [ ] Historia lekcji klienta i ręczna korekta salda z notatką.
- [ ] Lista osób na minusie.
- [ ] Oznaczanie nieobecności.

### Pierwsze wdrożenie (po etapie 3)

- [ ] Wybór hostingu aplikacji i bazy, dostawcy maili i domeny szkoły ([decyzje.md](decyzje.md), „Technologia”).

### Etap 4. Płatności: zaplanowane

- [ ] Stripe Checkout: BLIK, karta, Przelewy24.
- [ ] Pierwsza lekcja nowej pary: termin czeka na płatność, a nieopłacony wraca do puli.
- [ ] Kupno pakietu lekcji online.
- [ ] Webhook Stripe: płatność dopisuje lekcje na konto (najwyżej raz).
- [ ] Gotówka w panelu: kto przyjął, ile zł, ile lekcji.
- [ ] Samodzielna rejestracja nowej pary na stronie szkoły (wcześniej bez etapu; pasuje tutaj, bo nowa para płaci za pierwszą lekcję online).

### Etap 5. Przypomnienia i zadania w tle: zaplanowane

- [ ] Przypomnienie mailem przed lekcją.
- [ ] Wygasanie blokad terminu na czas płatności.
- [ ] Lekcja po swoim końcu zmienia się na „odbytą”.
- [ ] Para po pierwszej odbytej lekcji staje się stała.

## Na później (po wersji 1)

- **Przesuwanie lekcji przeciąganiem** (zgłoszone 11.11.2026): kafelek lekcji w kalendarzu przeciągasz w inne miejsce i lekcja zmienia termin. Do ustalenia: czy para też może przesuwać swoje lekcje, czy wolno przesunąć lekcję po terminie odwołania i czy przesunięcie liczy się do limitu przełożeń.
- Lista rezerwowa i otwieranie grafiku partiami.
- Limit przełożeń na pakiet, ostrzeżenia po późnych odwołaniach, automatyczna utrata statusu zaufanego, potwierdzanie lekcji.
- Ważność pakietów.
- SMS, synchronizacja z Google Calendar, vouchery, eksport do Excela albo na endpoint.
- Nadpisywanie reguł grafiku dla instruktora albo usługi.
- Stripe Connect i zakładanie firm przez stronę.
- Do sprawdzenia przed sprzedażą:
  - z księgową: paragony i kasa fiskalna, zwłaszcza przy gotówce;
  - RODO: umowa powierzenia przetwarzania danych z każdą firmą.
