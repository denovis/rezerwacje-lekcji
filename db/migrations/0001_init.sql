-- =============================================================================
-- 0001_init.sql — model danych: rezerwacje lekcji indywidualnych, wiele firm w jednej bazie.
--
-- Zasady (opisane szerzej w docs/decyzje.md i docs/model-danych.md):
--   * Każda tabela z danymi firmy ma kolumnę organization_id.
--   * Odwołania między tabelami firmy idą przez złożony klucz (organization_id, id),
--     więc rezerwacja z firmy A nie może wskazać instruktora ani klienta z firmy B.
--   * Row-level security (RLS): aplikacja łączy się rolą app_user i w każdej transakcji
--     ustawia app.organization_id (oraz app.user_id). Widzi wtedy tylko dane tej firmy.
--   * Saldo lekcji to suma wpisów w credit_entries (historia tylko do dopisywania).
--   * Nakładające się rezerwacje tego samego instruktora blokuje sama baza (EXCLUDE).
--   * Nic nie kasujemy fizycznie: usługi, pakiety i instruktorzy mają flagę active.
--
-- Migrację uruchamia rola właściciela bazy (nie app_user).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- równość uuid w ograniczeniu EXCLUDE
CREATE EXTENSION IF NOT EXISTS citext;      -- e-maile bez rozróżniania wielkości liter

-- Rola, którą łączy się aplikacja. Nie jest właścicielem tabel, więc podlega RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Kontekst żądania: aplikacja ustawia go na początku każdej transakcji:
--   SELECT set_config('app.organization_id', '<uuid firmy>', true);
--   SELECT set_config('app.user_id', '<uuid użytkownika>', true);
-- Trzeci argument true = tylko do końca transakcji (bezpieczne przy puli połączeń).
-- -----------------------------------------------------------------------------
CREATE FUNCTION current_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION current_app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- -----------------------------------------------------------------------------
-- Typy
-- -----------------------------------------------------------------------------
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'instructor');

-- new: pierwsza lekcja tylko z płatnością online
-- regular: rezerwuje, gdy ma lekcje na koncie
-- trusted: może zejść poniżej zera do credit_limit (płaci gotówką na miejscu)
CREATE TYPE client_status AS ENUM ('new', 'regular', 'trusted');

-- pending_payment: termin trzymany na czas płatności online (hold_expires_at)
-- confirmed: zarezerwowana; completed: odbyta; no_show: nieobecność
-- cancelled: odwołana w terminie (lekcja wraca na konto)
-- late_cancelled: odwołana po terminie (lekcja przepada)
-- expired: nieopłacona w czasie blokady (termin wrócił do puli)
CREATE TYPE booking_status AS ENUM (
  'pending_payment', 'confirmed', 'completed', 'no_show', 'cancelled', 'late_cancelled', 'expired'
);

CREATE TYPE payment_method AS ENUM ('stripe', 'cash');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'expired', 'refunded');

-- purchase: dopisanie lekcji z płatności (online albo gotówka)
-- booking: zdjęcie lekcji przy rezerwacji
-- booking_refund: zwrot lekcji przy odwołaniu w terminie
-- adjustment: ręczna korekta admina (zawsze z notatką)
CREATE TYPE credit_reason AS ENUM ('purchase', 'booking', 'booking_refund', 'adjustment');

CREATE TYPE availability_exception_kind AS ENUM ('unavailable', 'extra');

-- -----------------------------------------------------------------------------
-- Firmy i użytkownicy
-- -----------------------------------------------------------------------------
CREATE TABLE organizations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  timezone          text NOT NULL DEFAULT 'Europe/Warsaw',
  currency          char(3) NOT NULL DEFAULT 'PLN',
  stripe_account_id text,          -- NULL = główne konto Stripe (na razie konto Damiana); później konto z Connect
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Konto logowania wspólne dla całego systemu (jedna osoba może należeć do kilku firm).
-- Tabele sesji i tokenów logowania dojdą z biblioteką logowania w etapie 2.
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      citext NOT NULL UNIQUE,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rola użytkownika w firmie: właściciel, admin, instruktor. Klienci są w tabeli clients.
CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  role            member_role NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- Klient firmy (dla szkoły pierwszego tańca: para). Może nie mieć konta (dodany przez admina).
CREATE TABLE clients (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid REFERENCES users (id),
  display_name    text NOT NULL,              -- np. „Anna i Piotr”
  email           citext,
  phone           text,
  target_date     date,                       -- np. data ślubu
  notes           text,
  status          client_status NOT NULL DEFAULT 'new',
  credit_limit    integer NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, user_id),
  -- Zejście poniżej zera tylko dla zaufanych.
  CONSTRAINT clients_credit_limit_only_trusted CHECK (status = 'trusted' OR credit_limit = 0)
);
CREATE UNIQUE INDEX clients_email_per_org ON clients (organization_id, email) WHERE email IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Instruktorzy i dostępność
-- -----------------------------------------------------------------------------
CREATE TABLE instructors (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid REFERENCES users (id),
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

-- Stałe godziny pracy w tygodniu, w czasie lokalnym firmy (organizations.timezone).
CREATE TABLE availability_rules (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  instructor_id   uuid NOT NULL,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- 1 = poniedziałek (ISO)
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  valid_from      date NOT NULL DEFAULT current_date,
  valid_to        date,
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (organization_id, instructor_id) REFERENCES instructors (organization_id, id)
);
CREATE INDEX availability_rules_instructor ON availability_rules (organization_id, instructor_id, weekday);

-- Wyjątki: urlop, wolne (unavailable) albo dodatkowe godziny (extra), w czasie bezwzględnym.
CREATE TABLE availability_exceptions (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  instructor_id   uuid NOT NULL,
  kind            availability_exception_kind NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  note            text,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (organization_id, instructor_id) REFERENCES instructors (organization_id, id)
);
CREATE INDEX availability_exceptions_instructor ON availability_exceptions (organization_id, instructor_id, starts_at);

-- -----------------------------------------------------------------------------
-- Usługi i pakiety
-- -----------------------------------------------------------------------------
CREATE TABLE services (
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  name             text NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 5 AND 600),
  credit_cost      integer NOT NULL DEFAULT 1 CHECK (credit_cost > 0),  -- ile lekcji z konta zdejmuje rezerwacja
  price_cents      integer CHECK (price_cents >= 0),                    -- cena pojedynczej lekcji płatnej online
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE packages (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name            text NOT NULL,                       -- np. „Pakiet 5 lekcji”
  credits         integer NOT NULL CHECK (credits > 0),
  price_cents     integer NOT NULL CHECK (price_cents >= 0),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

-- -----------------------------------------------------------------------------
-- Płatności (online przez Stripe albo gotówka wpisana przez admina)
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id                         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id            uuid NOT NULL,
  client_id                  uuid NOT NULL,
  method                     payment_method NOT NULL,
  status                     payment_status NOT NULL DEFAULT 'pending',
  amount_cents               integer NOT NULL CHECK (amount_cents >= 0),
  credits                    integer NOT NULL CHECK (credits > 0),  -- ile lekcji dopisuje po opłaceniu
  package_id                 uuid,
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id   text,
  created_by                 uuid REFERENCES users (id),            -- admin, który przyjął gotówkę
  note                       text,
  paid_at                    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id)  REFERENCES clients (organization_id, id),
  FOREIGN KEY (organization_id, package_id) REFERENCES packages (organization_id, id),
  -- Gotówkę zawsze ktoś przyjmuje i nie ma ona sesji Stripe.
  CONSTRAINT payments_cash_has_admin CHECK (method <> 'cash' OR (created_by IS NOT NULL AND stripe_checkout_session_id IS NULL)),
  CONSTRAINT payments_paid_has_date CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
CREATE INDEX payments_client ON payments (organization_id, client_id, created_at);

-- -----------------------------------------------------------------------------
-- Rezerwacje
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  instructor_id   uuid NOT NULL,
  client_id       uuid NOT NULL,
  service_id      uuid NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  -- Koniec lekcji + przerwa po niej (ustawienie buffer_minutes w chwili rezerwacji).
  -- To ten przedział blokuje kalendarz instruktora.
  blocks_until    timestamptz NOT NULL,
  status          booking_status NOT NULL,
  hold_expires_at timestamptz,          -- pending_payment: do kiedy termin czeka na płatność
  payment_id      uuid,                 -- płatność online za tę lekcję (pierwsza lekcja nowego klienta)
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (ends_at > starts_at),
  CHECK (blocks_until >= ends_at),
  CONSTRAINT bookings_hold_has_expiry CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL),
  FOREIGN KEY (organization_id, instructor_id) REFERENCES instructors (organization_id, id),
  FOREIGN KEY (organization_id, client_id)     REFERENCES clients (organization_id, id),
  FOREIGN KEY (organization_id, service_id)    REFERENCES services (organization_id, id),
  FOREIGN KEY (organization_id, payment_id)    REFERENCES payments (organization_id, id),
  -- Ten sam instruktor nie może mieć dwóch nakładających się rezerwacji.
  -- Przedział [starts_at, blocks_until) jest prawostronnie otwarty: 16:00–17:00 i 17:00–18:00 nie kolidują.
  -- Odwołane i wygasłe rezerwacje nie blokują terminu.
  -- Uwaga: wygasłą blokadę (pending_payment po hold_expires_at) aplikacja zmienia na 'expired'
  -- w tej samej transakcji, zanim wstawi nową rezerwację — warunek EXCLUDE nie może używać now().
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    instructor_id WITH =,
    tstzrange(starts_at, blocks_until, '[)') WITH &&
  ) WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'no_show'))
);
CREATE INDEX bookings_client ON bookings (organization_id, client_id, starts_at);
CREATE INDEX bookings_payment ON bookings (payment_id) WHERE payment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Historia lekcji klienta (saldo = suma delta). Tylko dopisywanie — aplikacja nie ma UPDATE/DELETE.
-- -----------------------------------------------------------------------------
CREATE TABLE credit_entries (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  client_id       uuid NOT NULL,
  delta           integer NOT NULL CHECK (delta <> 0),
  reason          credit_reason NOT NULL,
  payment_id      uuid,
  booking_id      uuid,
  created_by      uuid REFERENCES users (id),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, client_id)  REFERENCES clients (organization_id, id),
  FOREIGN KEY (organization_id, payment_id) REFERENCES payments (organization_id, id),
  FOREIGN KEY (organization_id, booking_id) REFERENCES bookings (organization_id, id),
  CONSTRAINT credit_purchase_shape   CHECK (reason <> 'purchase'       OR (payment_id IS NOT NULL AND delta > 0)),
  CONSTRAINT credit_booking_shape    CHECK (reason <> 'booking'        OR (booking_id IS NOT NULL AND delta < 0)),
  CONSTRAINT credit_refund_shape     CHECK (reason <> 'booking_refund' OR (booking_id IS NOT NULL AND delta > 0)),
  CONSTRAINT credit_adjustment_shape CHECK (reason <> 'adjustment'     OR (created_by IS NOT NULL AND coalesce(btrim(note), '') <> ''))
);
CREATE INDEX credit_entries_client ON credit_entries (organization_id, client_id, created_at);
-- Ochrona przed powtórzonym webhookiem i podwójnym kliknięciem:
-- jedna płatność dopisuje lekcje raz, jedna rezerwacja zdejmuje lekcję raz i zwraca ją najwyżej raz.
CREATE UNIQUE INDEX credit_entries_one_purchase_per_payment ON credit_entries (payment_id) WHERE reason = 'purchase';
CREATE UNIQUE INDEX credit_entries_one_charge_per_booking   ON credit_entries (booking_id) WHERE reason = 'booking';
CREATE UNIQUE INDEX credit_entries_one_refund_per_booking   ON credit_entries (booking_id) WHERE reason = 'booking_refund';

-- Saldo każdego klienta. security_invoker = widok podlega RLS osoby, która go czyta.
CREATE VIEW client_balances WITH (security_invoker = true) AS
SELECT c.organization_id,
       c.id AS client_id,
       coalesce(sum(e.delta), 0)::integer AS balance
FROM clients c
LEFT JOIN credit_entries e ON e.organization_id = c.organization_id AND e.client_id = c.id
GROUP BY c.organization_id, c.id;

-- -----------------------------------------------------------------------------
-- Ustawienia firmy (reguły konfigurowane w panelu). Wartości domyślne do zmiany.
-- -----------------------------------------------------------------------------
CREATE TABLE organization_settings (
  organization_id                 uuid PRIMARY KEY REFERENCES organizations (id),
  -- Grafik. Domyślnie lekcje jedna po drugiej: kolejna zaczyna się zaraz po końcu poprzedniej,
  -- plus przerwa buffer_minutes. slot_step_minutes działa tylko przy back_to_back_slots = false.
  back_to_back_slots              boolean NOT NULL DEFAULT true,
  slot_step_minutes               integer NOT NULL DEFAULT 30   CHECK (slot_step_minutes BETWEEN 5 AND 240),
  buffer_minutes                  integer NOT NULL DEFAULT 0    CHECK (buffer_minutes BETWEEN 0 AND 240),    -- przerwa po każdej lekcji
  min_gap_minutes                 integer NOT NULL DEFAULT 0    CHECK (min_gap_minutes BETWEEN 0 AND 600),   -- 0 = wyłączone
  compact_days                    boolean NOT NULL DEFAULT false,                                             -- „przyklejanie”
  min_notice_minutes              integer NOT NULL DEFAULT 1440 CHECK (min_notice_minutes >= 0),
  max_advance_days                integer NOT NULL DEFAULT 60   CHECK (max_advance_days BETWEEN 1 AND 730),
  -- Odwołania i przypomnienia
  cancel_deadline_hours           integer NOT NULL DEFAULT 24   CHECK (cancel_deadline_hours >= 0),
  reminder_hours_before           integer NOT NULL DEFAULT 24   CHECK (reminder_hours_before >= 0),
  -- Płatności i statusy klientów
  first_lesson_prepaid            boolean NOT NULL DEFAULT true,
  payment_hold_minutes            integer NOT NULL DEFAULT 30   CHECK (payment_hold_minutes BETWEEN 30 AND 1440), -- Stripe Checkout: 30 min – 24 h
  auto_promote_after_first_lesson boolean NOT NULL DEFAULT true,
  auto_complete_lessons           boolean NOT NULL DEFAULT true,
  default_trusted_credit_limit    integer NOT NULL DEFAULT 1    CHECK (default_trusted_credit_limit >= 0)
);

-- -----------------------------------------------------------------------------
-- Dziennik działań (kto dodał gotówkę, zmienił status klienta itp.). Tylko dopisywanie.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  actor_user_id   uuid REFERENCES users (id),
  action          text NOT NULL,      -- np. 'payment.cash_added', 'client.status_changed'
  entity          text NOT NULL,
  entity_id       uuid,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org ON audit_log (organization_id, created_at);

-- =============================================================================
-- Uprawnienia i row-level security
-- =============================================================================
GRANT USAGE ON SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION current_org_id(), current_app_user_id() TO app_user;

GRANT SELECT, UPDATE ON organizations TO app_user;          -- nowe firmy zakłada platforma (rola właściciela)
GRANT SELECT, INSERT, UPDATE ON users TO app_user;           -- konto globalne, bez RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON
  memberships, clients, instructors, availability_rules, availability_exceptions,
  services, packages, payments, bookings, organization_settings
TO app_user;
GRANT SELECT, INSERT ON credit_entries, audit_log TO app_user;  -- historia i dziennik: tylko dopisywanie
GRANT SELECT ON client_balances TO app_user;

-- Firmy: odczyt dla wszystkich (publiczna strona rezerwacji po slugu), zmiana tylko własnej.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_read  ON organizations FOR SELECT USING (true);
CREATE POLICY organizations_write ON organizations FOR UPDATE
  USING (id = current_org_id()) WITH CHECK (id = current_org_id());

-- Role w firmach: dane bieżącej firmy + własne członkostwa (wybór firmy po zalogowaniu).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant   ON memberships
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());
CREATE POLICY memberships_own_read ON memberships FOR SELECT
  USING (user_id = current_app_user_id());

-- Klienci: dane bieżącej firmy + własne profile klienta w innych firmach (tylko odczyt).
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant   ON clients
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());
CREATE POLICY clients_own_read ON clients FOR SELECT
  USING (user_id = current_app_user_id());

-- Pozostałe tabele firmy: wyłącznie bieżąca firma.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'instructors', 'availability_rules', 'availability_exceptions', 'services', 'packages',
    'payments', 'bookings', 'credit_entries', 'organization_settings', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id())',
      t || '_tenant', t
    );
  END LOOP;
END
$$;
