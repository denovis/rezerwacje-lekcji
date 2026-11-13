# Decyzje projektu

Wersja 0.9 z 13.11.2026. To żywy dokument: gdy zmienia się decyzja, zmieniamy ją tutaj w tym samym PR co kod.

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
- Rezerwacja przechodzi, jeśli po zdjęciu lekcji saldo ≥ −limit. Sprawdza to aplikacja w transakcji z blokadą wiersza klienta (`src/lib/bookings.ts`), więc dwie rezerwacje tej samej pary w tej samej chwili nie zejdą razem poniżej limitu.
- Nowy klient, który ma już opłacone lekcje na koncie (np. kupił pakiet), rezerwuje jak stały. Bez lekcji na koncie płaci za lekcję online (do etapu 4 dostaje odmowę z informacją o płatności online).
- Po wyłączeniu `first_lesson_prepaid` nowy klient bez lekcji na koncie dostaje taką samą odmowę jak stały. Lekcja z płatnością na miejscu jest tylko dla zaufanych.

### Kto rezerwuje

- **Klient** rezerwuje dla siebie i tylko wolny termin wyliczony z reguł grafiku.
- **Szkoła** (właściciel, admin) rezerwuje dla dowolnego klienta i o dowolnej godzinie, także poza godzinami pracy, byle lekcja nie nachodziła na inną. Zasady salda obowiązują tak samo.
- Rola instruktora na razie nie rezerwuje ani nie odwołuje lekcji. Widzi tylko lekcje, które sam prowadzi (etap 3b).

### Saldo lekcji to historia wpisów

- Saldo nie jest zapisaną liczbą, tylko sumą wpisów w `credit_entries`:
  - `purchase` +N za płatność online albo gotówkową,
  - `booking` −koszt przy rezerwacji,
  - `booking_refund` +koszt przy odwołaniu w terminie,
  - `adjustment` ±N, ręczna korekta admina, zawsze z autorem i notatką.
- Historię można tylko dopisywać. Aplikacja nie ma uprawnień do zmiany ani usuwania wpisów.
- Jedna płatność dopisuje lekcje najwyżej raz, a jedna rezerwacja zdejmuje lekcję raz i zwraca ją najwyżej raz. Pilnuje tego baza (unikalne indeksy), więc powtórzony webhook ze Stripe nic nie zepsuje.

### Płatności

- **Płatności online (etap 4b):** Stripe Checkout z kartą, BLIK-iem i Przelewy24 (metody włącza się w panelu Stripe; BLIK i Przelewy24 tylko w PLN). Bez `STRIPE_SECRET_KEY` płatności online są wyłączone, a nowa para bez lekcji dostaje informację, żeby skontaktowała się ze szkołą.
  - Lokalnie aplikacja nie wystartuje z produkcyjnym kluczem Stripe (`sk_live_`), tylko z testowym.
  - Kod zna Stripe tylko przez `src/lib/stripe-gateway.ts`; zasady płatności są w `src/lib/payments.ts` i mają testy na prawdziwej bazie bez łączenia się ze Stripe.
- **Pierwsza lekcja nowego klienta:**
  - rezerwacja dostaje status `pending_payment` i trzyma termin przez `payment_hold_minutes` (30–1440, w Ustawieniach) plus minutę zapasu na założenie sesji;
  - kwota to cena lekcji z usługi; bez ceny nowa para dostaje odmowę z informacją o płatności online;
  - sesja Stripe Checkout kończy się razem z blokadą terminu (Stripe wymaga od 30 minut do 24 godzin);
  - po zapłacie rezerwacja jest zarezerwowana, a w historii są dwa wpisy: +lekcja z płatności i −lekcja za rezerwację (saldo bez zmian);
  - zdarzenie `checkout.session.expired` albo nieudana płatność (`async_payment_failed`) zmienia rezerwację na `expired` i termin wraca do puli; blokada, której czas minął, i tak nie zajmuje terminu; zadania w tle (etap 5a) w ciągu minuty zmieniają ją na `expired`, a płatność przepada (`expired`); to samo robi też kolejna rezerwacja u tego instruktora;
  - para może dokończyć płatność („Zapłać”) albo zrezygnować („Zrezygnuj z lekcji”) w okienku lekcji; rezygnacja od razu zwalnia termin i zamyka sesję w Stripe;
  - płatność, która dotrze po zwolnieniu terminu, trafia na konto klienta jako lekcja do wykorzystania, a w dzienniku zostaje wpis `payment.late`. Widoczny alert dla szkoły jest w planie (etap 5).
  - Szkoła nie wpisuje nowej parze lekcji z płatnością online: wtedy przyjmuje gotówkę (zakładka „Wpłata”).
- **Pakiet online (etap 4b):** para kupuje pakiet przyciskiem „Kup pakiet lekcji” pod saldem. Płatność czeka godzinę; lekcje trafiają na konto po zapłacie.
- **Potwierdzenie płatności:** przychodzi webhookiem (`/api/stripe/webhook`, podpis sprawdzany sekretem `STRIPE_WEBHOOK_SECRET`) i dodatkowo przy powrocie pary ze strony płatności (aplikacja pyta Stripe o sesję). Oba są odporne na powtórzenia: płatność zmienia się na opłaconą raz, a unikalny indeks w bazie nie dopuści drugiego wpisu `purchase`. BLIK i Przelewy24 mogą potwierdzić się później (`async_payment_succeeded`); do tego czasu lekcja czeka.
  - Firmę i płatność wskazują metadane sesji, które ustawia tylko nasz serwer; zdarzenie z sesją innej płatności jest pomijane.
- **Gotówka (etap 4a):** szkoła przyjmuje ją na stronie Klienci, w okienku pary, zakładka „Wpłata”.
  - Za pakiet albo za pojedyncze lekcje (1–100). Kwota (0–100 000 zł) podpowiada się z ceny pakietu albo z ceny lekcji razy liczba lekcji, ale szkoła może ją zmienić (np. rabat; 0 zł to lekcja gratis).
  - Wpłata to opłacona płatność `cash` z osobą, która przyjęła, kwotą, liczbą lekcji i pakietem oraz wpis `purchase` +N w historii. Blokuje wiersz klienta jak rezerwacja i korekta.
  - Nowa para z lekcjami z wpłaty gotówką rezerwuje jak stała (bez płatności online).
- **Cennik (etap 4a):** w Ustawieniach.
  - Cena pojedynczej lekcji w usłudze (0–10 000 zł, puste pole = bez ceny); od etapu 4b także kwota płatności online za pierwszą lekcję.
  - Pakiety lekcji: nazwa, 1–100 lekcji, cena 0–100 000 zł. Wyłączonego pakietu nie da się sprzedać; nic nie kasujemy, wcześniejsze sprzedaże zostają z kwotą z chwili sprzedaży.
  - Kwoty zapisujemy w groszach; w interfejsie po polsku, np. „900,00 zł”.
- **Konto Stripe:** na razie główne konto Damiana, więc `organizations.stripe_account_id` = NULL. Stripe Connect włączymy później na tym samym koncie jako platformie. Jego szkoła dalej przyjmuje płatności na to konto, a kolejne firmy podłączają własne konta.

### Odwołania

- Do `cancel_deadline_hours` przed lekcją (włącznie z tą chwilą): status `cancelled` i lekcja wraca na konto (wpis `booking_refund`).
- Po tym terminie: status `late_cancelled` i lekcja przepada.
- Lekcji, która już się zaczęła, nie można odwołać.
- Szkoła odwołuje lekcję klienta według tych samych zasad i zapisuje, kto odwołał. Gdy lekcję odwołuje szkoła po terminie, a lekcja ma wrócić na konto, admin dopisuje korektę `adjustment` z notatką.
- Nieobecność: status `no_show` i lekcja przepada. Szkoła oznacza ją w kalendarzu od początku lekcji (zarezerwowanej albo odbytej). Pomyłkę można cofnąć: lekcja wraca do statusu sprzed oznaczenia.
- Lekcja sama zmienia się na `completed` po swoim końcu (ustawienie `auto_complete_lessons`, zadania w tle z etapu 5a). Nieobecność szkoła oznacza przed tym albo po tym.

### Reguły grafiku (ustawienia firmy w `organization_settings`)

Długość lekcji ustawia się w usłudze (`services.duration_minutes`), domyślnie 45 minut. Firma może mieć kilka usług o różnej długości.

| Ustawienie | Domyślnie | Co robi |
|---|---|---|
| `back_to_back_slots` | tak | lekcje jedna po drugiej: kolejna zaczyna się zaraz po końcu poprzedniej, plus przerwa `buffer_minutes` |
| `slot_step_minutes` | 30 | działa po wyłączeniu `back_to_back_slots`: lekcje zaczynają się co tyle minut (16:00, 16:30, 17:00…) |
| `buffer_minutes` | 0 | przerwa po każdej lekcji; blokuje kalendarz |
| `min_gap_minutes` | 0 (wyłączone) | nie pokazuje terminów, które zostawiłyby przerwę krótszą niż ta wartość |
| `compact_days` | nie | „przyklejanie”: gdy dzień ma rezerwację, pokazuje tylko terminy tuż obok niej |
| `min_notice_minutes` | 1440 (24 h) | najkrótsze wyprzedzenie rezerwacji |
| `max_advance_days` | 60 | jak daleko do przodu można rezerwować |
| `cancel_deadline_hours` | 24 | do kiedy odwołanie zwraca lekcję |
| `reminder_hours_before` | 24 | kiedy wysłać przypomnienie |
| `first_lesson_prepaid` | tak | pierwsza lekcja nowego klienta tylko z płatnością online |
| `payment_hold_minutes` | 30 | jak długo termin czeka na płatność (30 min – 24 h) |

Lekcje jedna po drugiej przy godzinach pracy 16:00–21:00 i lekcjach po 45 minut (sprawdzone skryptem):
- bez przerwy: 16:00, 16:45, 17:30, 18:15, 19:00 i 19:45; ostatnia kończy się 20:30, a ostatnich 30 minut nie da się zarezerwować, bo nie zmieści się w nich cała lekcja;
- z przerwą 15 minut: 16:00, 17:00, 18:00, 19:00 i 20:00;
- lekcje „przyklejają się” do rezerwacji, także gdy admin wpisał lekcję o innej godzinie: po rezerwacji następny termin zaczyna się zaraz po jej końcu (plus przerwa), a terminy przed nią liczą się wstecz, tak żeby ostatni kończył się tuż przed nią. Przy lekcji 17:00–17:45 wolne terminy to 16:15, 17:45, 18:30, 19:15 i 20:00, a przy lekcji 17:45–18:30: 16:15, 17:00, 18:30, 19:15 i 20:00. Krótki wolny czas zostaje wtedy na brzegu godzin pracy, nie w środku dnia;
- między dwiema rezerwacjami terminy liczą się od końca wcześniejszej.

Przykład dla `min_gap_minutes` = 60 przy stałej siatce co 30 minut (`back_to_back_slots` wyłączone), sprawdzony skryptem:
- okno 16:00–21:00, lekcje po 60 minut, rezerwacja 18:00–19:00;
- znikają 16:30 i 19:30, bo każdy z tych terminów zostawiłby po 30 minut z obu stron;
- zostają 16:00, 17:00, 19:00 i 20:00.

Wszystkie powyższe przykłady są testami w `src/lib/slots.test.ts`. Doprecyzowania z etapu 3:
- Wolne terminy wylicza czysta funkcja `freeSlots` (`src/lib/slots.ts`): godziny pracy plus dodatkowe godziny (`extra`), minus wolne i urlopy (`unavailable`), minus rezerwacje z przerwą po nich.
- Cała lekcja musi zmieścić się w godzinach pracy. Przerwa po ostatniej lekcji dnia może wyjść poza godziny pracy, ale nie może nachodzić na inną rezerwację.
- Stała siatka (`slot_step_minutes`) liczy się od początku każdego okna dostępności. Rezerwacja wpisana o innej godzinie jej nie przesuwa.
- `min_gap_minutes`: wolny czas z każdej strony lekcji, do sąsiedniej rezerwacji albo do brzegu godzin pracy, musi wynosić 0 albo co najmniej tyle minut.
- `compact_days`: w dniu z rezerwacją widać tylko najbliższy termin tuż przed każdą rezerwacją i tuż po niej. Potem działa jeszcze `min_gap_minutes`.
- `max_advance_days` liczymy w dniach kalendarzowych: cały dzień otwiera się o północy czasu lokalnego firmy.

### Kalendarz w panelu

- Panel firmy to jedna strona z kalendarzem tygodniowym: siatka godzin jak w Google Calendar albo lista dni (przełącznik „Kalendarz / Lista”).
- Klient widzi saldo, najbliższą lekcję, swoje lekcje i wolne terminy. Rezerwuje kliknięciem w wolny termin i potwierdzeniem w okienku, a odwołuje kliknięciem w swoją lekcję. Strona się nie przeładowuje, a wynik pokazuje dymek na dole ekranu.
- Szkoła widzi lekcje wszystkich klientów. Wpisuje lekcję kliknięciem w wolny termin albo w puste miejsce w siatce (także poza godzinami pracy) i wybiera klienta w tym samym okienku.
- W tym samym okienku szkoła przełącza „Lekcja / Wolne / Dodatkowe godziny” i wpisuje urlop, wolne albo dodatkowe godziny instruktora. Wolne widać w siatce jako szary pas, a dodatkowe godziny jako pas z kreską z boku. Kliknięcie pasa pokazuje szczegóły i pozwala go odwołać. Gdy szkoła ma kilku instruktorów, klikalna jest tylko etykieta pasa, żeby wolne jednej osoby nie zasłaniało dnia pozostałym.
- Instruktor z kontem logowania (adres e-mail wpisany przy instruktorze) widzi ten sam kalendarz tylko ze swoimi lekcjami, tylko do podglądu: bez wolnych terminów, rezerwacji i odwołań. Siatka obejmuje jego godziny pracy i lekcje. Osoba, która jest w firmie i klientem, i instruktorem, widzi kalendarz klienta.

### Ustawienia grafiku w panelu (etap 3b)

Szkoła (właściciel, admin) ustawia grafik na osobnej stronie „Ustawienia” (przycisk nad kalendarzem; do etapu 4a nazywała się „Ustawienia grafiku”). Strona ma części: instruktorzy z godzinami pracy i wolnym, reguły grafiku, usługi z ceną lekcji i pakiety lekcji. Zmiany robi się w okienkach na miejscu, a wynik pokazuje dymek na dole ekranu. Inne osoby wracają z tej strony do kalendarza. Ustawienia zmieniają się tylko przez `src/lib/schedule-setup.ts`, a każda zmiana trafia do dziennika (`audit_log`).

- **Instruktorzy:** dodawanie, zmiana nazwy, wyłączanie i ponowne włączanie.
  - Wyłączony instruktor znika z grafiku. Jego zaplanowane lekcje zostają w kalendarzu, a okienko podaje ich liczbę, żeby szkoła mogła je odwołać.
  - Adres e-mail przy instruktorze jest opcjonalny. Daje konto logowania (to samo, jeśli adres jest już w systemie) i rolę instruktora w firmie, chyba że osoba ma już inną rolę, np. właściciel, który sam uczy. Jedno konto to najwyżej jeden instruktor w firmie (pilnuje baza).
  - Po usunięciu adresu albo wyłączeniu instruktora rola w firmie zostaje (nic nie kasujemy), ale osoba nie widzi już żadnych lekcji. Odbieranie ról jest w planie na później.
- **Stałe godziny pracy** zmieniają się „od dnia”: od dziś albo od dnia w przyszłości, nigdy wstecz.
  - Godziny sprzed tego dnia dostają `valid_to` = dzień wcześniej, a godziny zaplanowane od tego dnia lub później zastępują nowe (stare dostają `active = false`).
  - W jednym dniu może być kilka odcinków (np. 10:00–12:00 i 16:00–21:00), ale nie mogą na siebie nachodzić; stykać się mogą.
  - Pusta lista godzin oznacza, że od tego dnia instruktor nie ma stałych godzin pracy.
  - Zaznaczenie dnia w okienku kopiuje godziny z najbliższego wcześniejszego dnia pracy, żeby nie wpisywać ich od nowa.
- **Wolne i dodatkowe godziny** (`availability_exceptions`): całe dni (urlop) albo godziny w jednym dniu albo na przełomie dni.
  - Całe dni trwają od północy pierwszego dnia do północy po ostatnim dniu czasu lokalnego firmy.
  - Wolne nie odwołuje lekcji: lekcje w tym czasie zostają, a komunikat podaje ich liczbę. Szkoła odwołuje je sama według zwykłych zasad.
  - Wpis musi się kończyć w przyszłości i trwać najwyżej rok. Odwołany wpis zostaje w bazie z `active = false`.
- **Reguły grafiku** w panelu: `back_to_back_slots`, `slot_step_minutes`, `buffer_minutes`, `min_gap_minutes`, `compact_days`, `min_notice_minutes` (w panelu w godzinach), `max_advance_days`, `cancel_deadline_hours` i `first_lesson_prepaid`. Wolne terminy liczą się według nich od razu; zarezerwowane lekcje zostają bez zmian.
  - Zakresy: lekcje co 5–240 min, przerwa 0–240 min, najkrótsza dziura 0–600 min, wyprzedzenie 0–720 h, horyzont 1–730 dni, termin odwołania 0–720 h.
  - Domyślny limit zaufanej pary (`default_trusted_credit_limit`, 0–20 lekcji) jest w tych samych ustawieniach, w części „Klienci” (etap 3c).
  - Automatyczne zmiany statusów (`auto_complete_lessons`, `auto_promote_after_first_lesson`) są w części „Po lekcji” (etap 5a). Kiedy wysłać przypomnienie (`reminder_hours_before`) dojdzie w etapie 5b (`plan.md`).
- **Usługi:** nazwa, długość (5–600 min), ile lekcji zdejmuje z konta (1–10), wyłączanie i włączanie.
  - Nowa długość i koszt dotyczą nowych rezerwacji; zarezerwowane lekcje zostają bez zmian.
  - Ostatniej aktywnej usługi nie można wyłączyć, bo nikt nie mógłby zarezerwować lekcji.
  - Domyślna usługa w kalendarzu to pierwsza dodana; kolejne usługi są w kolejności dodania.

### Klienci w panelu (etap 3c)

Szkoła (właściciel, admin) prowadzi klientów na stronie „Klienci” (przycisk nad kalendarzem, obok „Ustawienia”). Lista par ma wyszukiwanie (nazwa, e-mail, telefon) i filtr „Na minusie”. Kliknięcie pary otwiera okienko z zakładkami „Historia”, „Wpłata” (gotówka, etap 4a), „Korekta” i „Dane”. Inne osoby wracają z tej strony do kalendarza. Zasady pilnuje `src/lib/clients.ts`, a zmiany danych, statusu i nieobecności trafiają do dziennika (`audit_log`).

- **Dodawanie pary:** nazwa, e-mail, telefon, data ślubu, notatki i status (domyślnie nowa).
  - Z adresem e-mail para dostaje konto logowania (to samo, jeśli adres jest już w systemie) i od razu loguje się linkiem z maila. Bez adresu para nie ma konta, ale szkoła wpisuje jej lekcje.
  - Adres e-mail i konto są unikalne w szkole, bez względu na wielkość liter.
  - Zmiana adresu łączy profil z kontem nowego adresu. Usunięcie adresu nie odłącza konta, którym para już się loguje.
- **Status i limit:** szkoła zmienia status ręcznie (nowy, stały, zaufany).
  - Przy zmianie na zaufaną para dostaje domyślny limit firmy; szkoła może go zmienić (0–20 lekcji). Zaufana para przy zmianie samych danych zachowuje swój limit.
  - Inny status zawsze ma limit 0, tak jak pilnuje baza. Para na minusie, która przestaje być zaufana, zostaje na minusie i nie zarezerwuje lekcji, dopóki saldo nie wróci do zera.
- **Historia lekcji:** wszystkie wpisy salda od najnowszego, z terminem i stanem lekcji (np. odwołana, nieobecność), notatką, autorem i saldem po każdym wpisie.
- **Korekta salda:** „Dopisz lekcje” albo „Odejmij lekcje”, 1–50 lekcji naraz, zawsze z notatką; zapisuje autora. To nowy wpis `adjustment`, historii nie zmieniamy.
  - Korekta służy do poprawek (np. zwrot lekcji odwołanej przez szkołę po terminie); gotówkę przyjmuje się w zakładce „Wpłata”.
  - Korekta blokuje wiersz klienta, tak jak rezerwacja, więc obie zmiany salda tej pary w tej samej chwili czekają na siebie.
- **Na minusie:** pary z saldem poniżej zera, od największego długu.
- **Nieobecność:** w okienku lekcji w kalendarzu („Oznacz nieobecność”, „Cofnij nieobecność”), tylko dla szkoły. Okienko lekcji ma też link do historii i salda pary.

### Samodzielna rejestracja nowej pary (etap 4c)

Nowa para zapisuje się sama na stronie zapisów szkoły: `/zapisy/<adres szkoły>`, np. `/zapisy/szkola-pierwszego-tanca`. Szkoła ma ten link na stronie Klienci (przycisk „Kopiuj link”) i wkleja go parom, np. na swoją stronę albo w wiadomości. Zasady pilnuje `src/lib/registration.ts`.

- **Najpierw adres e-mail, potem dane.** Para podaje adres i dostaje link z maila (ten sam co przy logowaniu). Kliknięcie linku potwierdza adres, zakłada konto i wraca na stronę zapisów, gdzie para podaje dane. Po zapisie trafia prosto do kalendarza.
  - Dlaczego w tej kolejności: do potwierdzenia adresu nic nie trafia do danych szkoły. Nikt nie zapisze pary cudzym adresem, a szkoła nie dostaje profili, których nie da się usunąć (nic nie kasujemy).
  - Formularz zawsze odpowiada „wysłaliśmy link”, więc nie zdradza, czy adres jest już w systemie.
- **Dane:** nazwa pary i telefon są wymagane (szkoła musi mieć jak zadzwonić), data ślubu jest opcjonalna. Adres e-mail profilu to adres, którym para się zalogowała, a nie wpisany w formularzu.
- **Status:** nowa para dostaje status `new` i limit 0, tak jak para dodana przez szkołę. Pierwszą lekcję opłaca online (etap 4b) albo dostaje lekcje od szkoły (gotówka).
- **Bez dubli:** para, która ma już profil w szkole (zapisała się wcześniej albo dodała ją szkoła z tym adresem), od razu trafia do kalendarza. Dwa zapisy tej samej osoby w tej samej chwili zakładają jeden profil (pilnuje unikalny indeks w bazie).
  - Gdy szkoła ma już parę z tym adresem, ale bez konta (np. ze starych danych), zapis odmawia i prosi o kontakt ze szkołą.
  - Para dodana przez szkołę bez adresu e-mail, która zapisze się sama, będzie miała dwa profile. Łączenie profili jest w planie na później.
- **Osoba z rolą w szkole** (właściciel, administrator, instruktor) nie zapisuje się jako para; profil klienta może jej założyć szkoła. Strona zapisów mówi jej to i pozwala się wylogować, żeby sprawdzić zapis innym adresem.
- **Każda szkoła ma stronę zapisów** (bez wyłącznika). Strona jest dostępna tylko pod adresem, który szkoła sama komuś poda. Wyłącznik zapisów w ustawieniach jest w planie na później.
- Zapis trafia do dziennika (`audit_log`, `client.registered`). Mail do szkoły o nowej parze jest w planie (etap 5b).

### Zadania w tle (etap 5a)

Serwer aplikacji sam zmienia statusy, które zależą od upływu czasu: od razu po starcie, potem co minutę. Zasady pilnuje `src/lib/background.ts`.

- **Jak działają:** Next.js uruchamia je przy starcie serwera (`src/instrumentation.ts`), bez osobnego procesu ani crona. Gdy aplikacja nie działa (np. wyłączony komputer), nic się nie zmienia, a po starcie zadania od razu nadrabiają zaległości.
  - Każda firma osobno, w transakcji z ustawioną firmą (`withTenant`), więc działa RLS. Błąd w jednej firmie trafia do logu serwera, a pozostałe firmy idą dalej.
  - Zadania można powtarzać: zmieniają tylko wiersze w starym stanie, więc dwa przebiegi naraz (np. dwa serwery) niczego nie zdublują.
  - Każda zmiana trafia do dziennika (`audit_log`) bez autora: `booking.hold_expired`, `booking.completed`, `client.promoted`.
- **Wygasła blokada terminu na płatność:** rezerwacja `expired`, termin wraca do puli, płatność przepada (`expired`). Płatność, która dotrze później, i tak trafia na konto pary jako lekcja do wykorzystania (`payment.late`).
- **Lekcja odbyta:** zarezerwowana lekcja po swoim końcu zmienia się na `completed` (ustawienie `auto_complete_lessons`, domyślnie włączone). Odwołane lekcje, nieobecności i lekcje czekające na płatność zostają bez zmian. Nieobecność szkoła może oznaczyć także na lekcji odbytej.
- **Awans nowej pary:** nowa para, której lekcja właśnie zmieniła się na odbytą, staje się stała (ustawienie `auto_promote_after_first_lesson`, domyślnie włączone). Limit zostaje 0.
  - Awans liczy się w chwili oznaczenia lekcji jako odbytej. Para, którą szkoła potem sama ustawi z powrotem jako nową, zostaje nowa do kolejnej odbytej lekcji.
  - Awans działa tylko razem z oznaczaniem lekcji jako odbytych. Jeśli szkoła oznaczy nieobecność już po awansie, status zostaje; szkoła może go zmienić na stronie Klienci.
  - Zaufana para zostaje zaufana ze swoim limitem.
- **Ustawienia:** oba przełączniki są w Ustawieniach, w części „Po lekcji”.

### Na później (poza wersją 1)

Lista pomysłów na później jest w [plan.md](plan.md), razem z etapami wersji 1.

## 3. Technologia

- **Język i baza:** TypeScript, Next.js 16 (App Router), PostgreSQL 16.
- **Najpierw baza:** migracje SQL w `db/migrations` są źródłem prawdy, a uruchamia je `db/migrate.ts`.
- **Zapytania: Kysely** (wybrane w etapie 2):
  - typy tabel generuje `kysely-codegen` z bazy po migracjach (`npm run db:types` → `src/lib/db-types.ts`), a CI sprawdza, czy są aktualne;
  - w bazie nazwy w snake_case, w kodzie camelCase (CamelCasePlugin).
- **Logowanie: Better Auth z linkiem z maila** (wybrane w etapie 2):
  - bez haseł; pierwsze logowanie nowym adresem zakłada konto;
  - link działa 15 minut i tylko raz, a w bazie zapisujemy tylko skrót tokenu;
  - osoba dodana wcześniej przez szkołę loguje się do tego samego konta (ten sam e-mail), bez dublowania;
  - Auth.js odpadł: od września 2025 dostaje tylko poprawki bezpieczeństwa, a jego opiekunowie polecają Better Auth.
- **Maile:** wysyłka przez SMTP (nodemailer). Lokalnie Mailpit z docker-compose łapie wszystkie maile.
- **Zadania w tle (etap 5a):** uruchamia je sam serwer aplikacji (`src/instrumentation.ts`): od razu po starcie, potem co minutę. Bez osobnego procesu ani crona, więc wystarczy `npm run dev` albo `npm start`. Szczegóły w części „Zadania w tle”.
- **Testy:** Vitest na prawdziwym PostgreSQL (`docker compose`). Każda reguła biznesowa ma test nazwany jak reguła, po polsku. Kod pisze głównie AI, więc testy są głównym narzędziem kontroli. Na GitHubie przy każdym PR działają: sprawdzenie typów, testy, zgodność typów bazy i budowanie aplikacji.
- **Język w kodzie:** identyfikatory po angielsku; komentarze, dokumentacja i interfejs po polsku.
- **Wdrożenie (ustalone 12.11.2026):**
  - Na razie bez serwera w internecie: aplikacja działa lokalnie na komputerze właściciela (baza w Dockerze, `npm run dev` albo `npm run build && npm start`).
  - Przeniesienie później: kopia bazy (`pg_dump` / `pg_restore`) i te same zmienne środowiskowe na nowym serwerze. Nic w kodzie nie wiąże aplikacji z komputerem właściciela.
  - Gdy przyjdzie czas, polecany hosting to Render (Frankfurt): aplikacja i baza z kopiami w UE, bez administrowania serwerem. Do sprawdzenia przy zakładaniu: czy konto bazy może założyć rolę `app_user` (RLS) i rozszerzenia `btree_gist`, `citext`.
  - Maile: Brevo (UE, SMTP, za darmo do 300 maili dziennie). Lokalnie dalej Mailpit; żeby maile wychodziły naprawdę, wystarczy wpisać SMTP Brevo w `SMTP_URL`.
  - Domena: na start bez własnej domeny; dodamy ją przy wdrożeniu (maile z własnej domeny rzadziej trafiają do spamu).

## 4. Wiele firm w jednej bazie

- Każda tabela z danymi firmy ma `organization_id`.
- Odwołania między takimi tabelami idą przez złożony klucz `(organization_id, id)`. Rezerwacja z firmy A nie może więc wskazać instruktora ani klienta z firmy B, nawet przy błędzie w kodzie.
- **Row-level security:**
  - aplikacja loguje się do bazy rolą `app_user` (hasło ustawia `npm run db:app-login`) i nie wystartuje z innym kontem, bo np. właściciel bazy omija RLS;
  - dane firmy czyta i zmienia tylko przez `withTenant()`, które na początku transakcji ustawia `set_config('app.organization_id', …, true)` i `app.user_id`;
  - bez ustawionej firmy nie widzi żadnych danych firm.
- **Tabele logowania** (`auth_sessions`, `auth_accounts`, `auth_verifications`) są wspólne dla całego systemu, bez `organization_id` i RLS.
- **Konta:** `users` to konto logowania wspólne dla całego systemu. Rola w firmie siedzi w `memberships` (właściciel, admin, instruktor). Klient to osobny rekord w `clients`, z kontem albo bez.
- **Co widzi zalogowany użytkownik:** swoje członkostwa i profile klienta we wszystkich firmach, ale tylko do odczytu. Dzięki temu po zalogowaniu wybiera firmę.
- **Tabela `organizations`:** można ją czytać bez kontekstu (publiczna strona rezerwacji po adresie). Nowe firmy zakłada platforma, nie aplikacja.
- **Nic nie kasujemy:** instruktorzy, usługi, pakiety, godziny pracy i wyjątki (urlop, dodatkowe godziny) mają flagę `active`, a historia płatności i lekcji zostaje. Wyjątek: sesje i zużyte tokeny logowania, bo to dane techniczne.
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

Etapy z listą rzeczy do zrobienia i stanem każdego z nich są w [plan.md](plan.md). W skrócie:

1. Model danych — gotowe (PR #1).
2. Szkielet aplikacji i logowanie — gotowe (PR #2).
3. Kalendarz i rezerwacje (3a) — gotowe (PR #3), ustawienia grafiku w panelu (3b) — gotowe (PR #4), klienci w panelu (3c) — gotowe (PR #5).
4. Płatności: ceny, pakiety i gotówka (4a) — gotowe (PR #6), płatności online przez Stripe (4b) — gotowe (PR #7), samodzielna rejestracja nowej pary (4c) — gotowe (PR #8).
5. Zadania w tle (5a) — gotowe (PR #9), maile: przypomnienia, alerty dla szkoły (5b).
