// Dostęp do bazy z aplikacji.
//
// Aplikacja łączy się rolą app_user, więc każde zapytanie podlega RLS: bez ustawionej firmy
// nie widać żadnych danych firm. Dane firmy czytamy i zmieniamy wyłącznie przez withTenant(),
// które w jednej transakcji ustawia firmę i zalogowanego użytkownika.
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './db-types';

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;

export function createDb(connectionString: string, options: { max?: number } = {}): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: options.max ?? 10 }) }),
    // Kolumny w bazie mają snake_case (organization_id), w TypeScript camelCase (organizationId).
    plugins: [new CamelCasePlugin()],
  });
}

export interface TenantContext {
  /** Firma, której dane są widoczne. null = żadna: widać tylko własne role i profile klienta. */
  organizationId: string | null;
  /** Zalogowany użytkownik. null = nikt. */
  userId: string | null;
}

/**
 * Wykonuje fn w transakcji z ustawioną firmą i użytkownikiem.
 * Ustawienia działają tylko do końca transakcji (set_config(…, true)),
 * więc nie przechodzą na kolejne zapytania z tej samej puli połączeń.
 * Błąd w fn wycofuje całą transakcję.
 */
export function withTenant<T>(db: Database, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.organization_id', ${ctx.organizationId ?? ''}, true),
                     set_config('app.user_id', ${ctx.userId ?? ''}, true)`.execute(tx);
    return fn(tx);
  });
}
