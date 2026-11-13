// Zadania w tle (etap 5a). Uruchamia je serwer aplikacji co minutę (src/instrumentation.ts),
// a po starcie od razu nadrabia to, co wypadło, gdy aplikacja nie działała.
//
// Zasady (docs/decyzje.md, „Zadania w tle”):
//  * Każda firma osobno, w transakcji z ustawioną firmą (withTenant), więc działa RLS. Błąd w jednej firmie
//    nie zatrzymuje pozostałych.
//  * Wygasła blokada terminu na płatność (pending_payment po hold_expires_at): rezerwacja 'expired', termin wraca
//    do puli, a płatność przepada ('expired'). Płatność, która dotrze później, i tak trafia na konto (payment.late).
//  * Lekcja po swoim końcu: 'confirmed' → 'completed' (ustawienie auto_complete_lessons).
//  * Nowa para, której lekcja właśnie się odbyła: 'new' → 'regular' (auto_promote_after_first_lesson).
//    Awans liczy się w chwili oznaczenia lekcji jako odbytej, więc para, którą szkoła potem sama ustawi jako nową,
//    zostaje nowa do kolejnej odbytej lekcji.
//  * Zadania można powtarzać: zmieniają tylko wiersze w starym stanie (UPDATE … WHERE status = …), więc dwa
//    przebiegi naraz niczego nie zdublują.
//  * Każda zmiana trafia do dziennika (audit_log) bez autora (actor_user_id = NULL).
import { withTenant, type Database, type Tx } from './db';
import type { Json } from './db-types';

/** Co zmieniło jedno przejście zadań. */
export interface TaskReport {
  /** Rezerwacje, które czekały na płatność dłużej niż blokada terminu. */
  expiredHolds: number;
  /** Lekcje oznaczone jako odbyte. */
  completedLessons: number;
  /** Nowe pary, które stały się stałe. */
  promotedClients: number;
}

const EMPTY: TaskReport = { expiredHolds: 0, completedLessons: 0, promotedClients: 0 };

async function auditMany(tx: Tx, organizationId: string, action: string, entity: string, rows: { id: string; data: Json }[]) {
  if (rows.length === 0) return;
  await tx
    .insertInto('auditLog')
    .values(
      rows.map((row) => ({
        organizationId,
        actorUserId: null,
        action,
        entity,
        entityId: row.id,
        data: JSON.stringify(row.data),
      })),
    )
    .execute();
}

/** Zadania w tle jednej firmy. */
export function runFirmTasks(db: Database, organizationId: string, now: Date = new Date()): Promise<TaskReport> {
  return withTenant(db, { organizationId, userId: null }, async (tx) => {
    const settings = await tx
      .selectFrom('organizationSettings')
      .select(['autoCompleteLessons', 'autoPromoteAfterFirstLesson'])
      .where('organizationId', '=', organizationId)
      .executeTakeFirst();
    if (!settings) return EMPTY;

    // 1. Blokady terminu, których czas minął: termin wraca do puli, płatność przepada.
    const expired = await tx
      .updateTable('bookings')
      .set({ status: 'expired' })
      .where('organizationId', '=', organizationId)
      .where('status', '=', 'pending_payment')
      .where('holdExpiresAt', '<=', now)
      .returning(['id', 'paymentId', 'holdExpiresAt'])
      .execute();
    const paymentIds = expired.flatMap((b) => (b.paymentId ? [b.paymentId] : []));
    if (paymentIds.length > 0) {
      await tx
        .updateTable('payments')
        .set({ status: 'expired' })
        .where('organizationId', '=', organizationId)
        .where('id', 'in', paymentIds)
        .where('status', '=', 'pending')
        .execute();
    }
    await auditMany(
      tx,
      organizationId,
      'booking.hold_expired',
      'bookings',
      expired.map((b) => ({ id: b.id, data: { paymentId: b.paymentId, holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null } })),
    );

    // 2. Lekcje po swoim końcu: odbyte.
    const completed = settings.autoCompleteLessons
      ? await tx
          .updateTable('bookings')
          .set({ status: 'completed' })
          .where('organizationId', '=', organizationId)
          .where('status', '=', 'confirmed')
          .where('endsAt', '<=', now)
          .returning(['id', 'clientId'])
          .execute()
      : [];
    await auditMany(
      tx,
      organizationId,
      'booking.completed',
      'bookings',
      completed.map((b) => ({ id: b.id, data: { previousStatus: 'confirmed' } })),
    );

    // 3. Nowe pary, których lekcja właśnie się odbyła: stałe (limit zostaje 0, jak u każdej stałej pary).
    const clientIds = [...new Set(completed.map((b) => b.clientId))];
    const promoted =
      settings.autoPromoteAfterFirstLesson && clientIds.length > 0
        ? await tx
            .updateTable('clients')
            .set({ status: 'regular' })
            .where('organizationId', '=', organizationId)
            .where('id', 'in', clientIds)
            .where('status', '=', 'new')
            .returning('id')
            .execute()
        : [];
    await auditMany(
      tx,
      organizationId,
      'client.promoted',
      'clients',
      promoted.map((c) => ({
        id: c.id,
        data: { previousStatus: 'new', status: 'regular', bookingId: completed.find((b) => b.clientId === c.id)?.id ?? null },
      })),
    );

    return { expiredHolds: expired.length, completedLessons: completed.length, promotedClients: promoted.length };
  });
}

/** Zadania w tle wszystkich firm. Błąd jednej firmy trafia do logu, a pozostałe firmy idą dalej. */
export async function runAllFirms(
  db: Database,
  now: Date = new Date(),
  log: Pick<Console, 'error'> = console,
): Promise<TaskReport> {
  // Tabelę firm można czytać bez wybranej firmy.
  const firms = await withTenant(db, { organizationId: null, userId: null }, (tx) =>
    tx.selectFrom('organizations').select('id').orderBy('createdAt').execute(),
  );
  const total = { ...EMPTY };
  for (const firm of firms) {
    try {
      const report = await runFirmTasks(db, firm.id, now);
      total.expiredHolds += report.expiredHolds;
      total.completedLessons += report.completedLessons;
      total.promotedClients += report.promotedClients;
    } catch (err) {
      log.error(`[zadania w tle] Błąd w firmie ${firm.id}:`, err);
    }
  }
  return total;
}

/** Opis zmian do logu serwera, np. „wygasłe blokady: 1, odbyte lekcje: 3”; null, gdy nic się nie zmieniło. */
export function describeReport(report: TaskReport): string | null {
  const parts = [
    report.expiredHolds ? `wygasłe blokady: ${report.expiredHolds}` : null,
    report.completedLessons ? `odbyte lekcje: ${report.completedLessons}` : null,
    report.promotedClients ? `pary stałe: ${report.promotedClients}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Co ile uruchamiamy zadania w tle. */
export const TASK_INTERVAL_MS = 60_000;

interface Running {
  stop: () => void;
}

const store = globalThis as typeof globalThis & { __rezerwacjeZadaniaWTle?: Running };

/**
 * Uruchamia zadania w tle w tym procesie: od razu (nadrobienie zaległości po starcie), potem co minutę.
 * Drugie wywołanie w tym samym procesie nic nie robi. Kolejny przebieg nie zaczyna się, dopóki trwa poprzedni.
 */
export function startBackgroundTasks(db: Database, options: { intervalMs?: number; log?: Pick<Console, 'info' | 'error'> } = {}): Running {
  if (store.__rezerwacjeZadaniaWTle) return store.__rezerwacjeZadaniaWTle;
  const log = options.log ?? console;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const summary = describeReport(await runAllFirms(db, new Date(), log));
      if (summary) log.info(`[zadania w tle] ${summary}`);
    } catch (err) {
      log.error('[zadania w tle] Błąd:', err);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? TASK_INTERVAL_MS);
  // Zegar nie trzyma procesu przy życiu (np. przy zamykaniu serwera).
  timer.unref();
  const running: Running = {
    stop: () => {
      clearInterval(timer);
      store.__rezerwacjeZadaniaWTle = undefined;
    },
  };
  store.__rezerwacjeZadaniaWTle = running;
  return running;
}
