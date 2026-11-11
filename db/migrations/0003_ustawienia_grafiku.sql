-- =============================================================================
-- 0003: ustawienia grafiku w panelu szkoły (etap 3b)
-- =============================================================================
-- Szkoła (właściciel, admin) ustawia w panelu instruktorów, ich stałe godziny pracy,
-- wyjątki (urlop, wolne, dodatkowe godziny), reguły grafiku i usługi.
--
-- Nic nie kasujemy fizycznie, więc godziny pracy i wyjątki dostają flagę active:
--   * godziny pracy zmieniają się „od dnia”: stare dostają valid_to, a godziny zaplanowane
--     od tego dnia lub później, których jeszcze nie było, wyłączamy (active = false);
--   * odwołany urlop albo dodatkowe godziny wyłączamy, zamiast kasować.
-- Uprawnienia app_user i RLS tych tabel są już w 0001_init.sql.

ALTER TABLE availability_rules
  ADD COLUMN active     boolean     NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE availability_exceptions
  ADD COLUMN active     boolean     NOT NULL DEFAULT true,
  ADD COLUMN created_by uuid REFERENCES users (id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Jedno konto logowania to najwyżej jeden instruktor w firmie (instruktor widzi w panelu swoje lekcje).
CREATE UNIQUE INDEX instructors_user_per_org ON instructors (organization_id, user_id) WHERE user_id IS NOT NULL;
