-- =============================================================================
-- 0002: logowanie linkiem z maila (Better Auth)
-- =============================================================================
-- Konto użytkownika (users) jest wspólne dla całego systemu. Better Auth potrzebuje
-- w nim kilku kolumn oraz trzech tabel:
--   * auth_sessions      — sesje zalogowanych osób (ciasteczko wskazuje token sesji),
--   * auth_accounts      — sposoby logowania (na przyszłość, np. konto Google),
--   * auth_verifications — jednorazowe tokeny z linków w mailach (zapisane jako skrót).
-- Te tabele nie należą do żadnej firmy, więc nie mają organization_id ani RLS.
-- Wyjątek od zasady „nic nie kasujemy”: sesje i zużyte tokeny wolno usuwać
-- (wylogowanie, wygaśnięcie) — to dane techniczne, nie historia biznesowa.
-- Nazwy kolumn w snake_case; aplikacja tłumaczy je na camelCase (CamelCasePlugin w Kysely).

ALTER TABLE users
  ADD COLUMN email_verified boolean     NOT NULL DEFAULT false,
  ADD COLUMN image          text,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

CREATE TABLE auth_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  token      text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE auth_accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users (id),
  account_id               text NOT NULL,   -- identyfikator konta u dostawcy logowania
  provider_id              text NOT NULL,   -- np. 'google'
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,            -- nieużywane: logujemy się tylko linkiem z maila
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX auth_accounts_user ON auth_accounts (user_id);

CREATE TABLE auth_verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,   -- skrót tokenu z linku
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier ON auth_verifications (identifier);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions, auth_accounts, auth_verifications TO app_user;
