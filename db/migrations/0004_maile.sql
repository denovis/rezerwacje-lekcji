-- =============================================================================
-- 0004: maile z zadań w tle (etap 5b)
-- =============================================================================
-- Zadania w tle wysyłają maile: przypomnienie parze przed lekcją oraz alerty dla szkoły
-- (płatność, która dotarła po zwolnieniu terminu; nowa para, która zapisała się sama).
--
-- Każdy mail ma tu swój wiersz, zanim wyjdzie. Unikalny klucz (firma, rodzaj, czego dotyczy, adresat)
-- pilnuje, żeby ten sam mail nie wyszedł dwa razy, także gdy zadania działają w dwóch procesach naraz.
-- Nieudana wysyłka zostaje jako 'failed' z liczbą prób i błędem; zadania próbują ponownie.
-- Nic nie kasujemy: aplikacja może te wiersze tylko dodawać i zmieniać ich stan.

-- lesson_reminder: przypomnienie parze o lekcji (entity_id = rezerwacja)
-- late_payment: alert dla szkoły o płatności po zwolnieniu terminu (entity_id = płatność)
-- client_registered: alert dla szkoły o nowej parze, która zapisała się sama (entity_id = klient)
CREATE TYPE email_kind AS ENUM ('lesson_reminder', 'late_payment', 'client_registered');

-- sending: zarezerwowany do wysłania (wysyłka w toku); sent: wysłany; failed: wysyłka się nie udała
CREATE TYPE email_status AS ENUM ('sending', 'sent', 'failed');

CREATE TABLE email_notifications (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  kind            email_kind NOT NULL,
  entity_id       uuid NOT NULL,          -- rezerwacja, płatność albo klient (zależnie od rodzaju)
  recipient       citext NOT NULL,
  status          email_status NOT NULL DEFAULT 'sending',
  attempts        integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (organization_id, id),
  -- Ten sam mail do tej samej osoby najwyżej raz.
  UNIQUE (organization_id, kind, entity_id, recipient),
  CONSTRAINT email_sent_has_date CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX email_notifications_failed ON email_notifications (organization_id, status) WHERE status = 'failed';

GRANT SELECT, INSERT, UPDATE ON email_notifications TO app_user;  -- bez DELETE: nic nie kasujemy

ALTER TABLE email_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_notifications_tenant ON email_notifications
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());
