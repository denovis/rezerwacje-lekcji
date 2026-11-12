'use server';
// Akcje ustawień: instruktorzy, godziny pracy, wolne i dodatkowe godziny, reguły grafiku, usługi i pakiety.
// Wywołują je strona ustawień i kalendarz; wynik (powodzenie albo komunikat po polsku) pokazują na miejscu.
// Każda akcja sama sprawdza logowanie i dostęp do firmy; zasady pilnuje src/lib/schedule-setup.ts.
import { revalidatePath } from 'next/cache';
import type { FirmContext } from '../../../lib/bookings';
import { findMyFirm } from '../../../lib/firms';
import { addPackage, PaymentError, updatePackage } from '../../../lib/payments';
import {
  addException,
  addInstructor,
  addService,
  cancelException,
  SetupError,
  setWeeklyHours,
  updateInstructor,
  updateScheduleRules,
  updateService,
  type ScheduleRules,
  type WorkRange,
} from '../../../lib/schedule-setup';
import { server } from '../../../lib/server';
import { requireUser } from '../../../lib/session';

export type SetupResult = { ok: true; lessonsInside?: number } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const integer = (value: unknown) => (typeof value === 'number' ? value : Number.NaN);
const uuid = (value: unknown) => {
  const id = text(value);
  if (!UUID.test(id)) throw new SetupError('invalid_request');
  return id;
};

/** Sprawdza logowanie i firmę, wykonuje zmianę i odświeża kalendarz oraz stronę ustawień. */
async function attempt(slugInput: unknown, change: (ctx: FirmContext) => Promise<SetupResult | void>): Promise<SetupResult> {
  const slug = text(slugInput);
  const user = await requireUser();
  const firm = await findMyFirm(server().db, user.id, slug);
  if (!firm) return { ok: false, error: new SetupError('not_allowed').message };
  try {
    return (await change({ organizationId: firm.id, userId: user.id })) ?? { ok: true };
  } catch (err) {
    if (err instanceof SetupError || err instanceof PaymentError) return { ok: false, error: err.message };
    throw err;
  } finally {
    revalidatePath(`/panel/${slug}`);
    revalidatePath(`/panel/${slug}/ustawienia`);
    revalidatePath(`/panel/${slug}/klienci`);
  }
}

export interface InstructorPayload {
  slug: string;
  /** Brak: nowy instruktor. */
  instructorId?: string;
  name: string;
  email: string;
  active?: boolean;
}

export async function saveInstructorAction(input: InstructorPayload): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    const fields = { name: text(input.name), email: text(input.email) };
    if (input.instructorId === undefined) {
      await addInstructor(server().db, ctx, fields);
    } else {
      await updateInstructor(server().db, ctx, { ...fields, instructorId: uuid(input.instructorId), active: input.active !== false });
    }
  });
}

export async function setHoursAction(input: {
  slug: string;
  instructorId: string;
  validFrom: string;
  ranges: WorkRange[];
}): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    if (!Array.isArray(input.ranges) || input.ranges.length > 50) throw new SetupError('invalid_request');
    const ranges = input.ranges.map((r) => ({ weekday: integer(r?.weekday), start: text(r?.start), end: text(r?.end) }));
    await setWeeklyHours(server().db, ctx, { instructorId: uuid(input.instructorId), validFrom: text(input.validFrom), ranges });
  });
}

export interface ExceptionPayload {
  slug: string;
  instructorId: string;
  kind: 'unavailable' | 'extra';
  startDate: string;
  endDate: string;
  /** Puste: cały dzień. */
  startTime: string;
  endTime: string;
  note: string;
}

export async function addExceptionAction(input: ExceptionPayload): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    if (input.kind !== 'unavailable' && input.kind !== 'extra') throw new SetupError('invalid_request');
    const result = await addException(server().db, ctx, {
      instructorId: uuid(input.instructorId),
      kind: input.kind,
      period: {
        startDate: text(input.startDate),
        endDate: text(input.endDate),
        startTime: text(input.startTime) || null,
        endTime: text(input.endTime) || null,
      },
      note: text(input.note),
    });
    return { ok: true, lessonsInside: result.lessonsInside };
  });
}

export async function cancelExceptionAction(input: { slug: string; exceptionId: string }): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    await cancelException(server().db, ctx, { exceptionId: uuid(input.exceptionId) });
  });
}

export async function saveRulesAction(input: { slug: string; rules: ScheduleRules }): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    const r = input.rules;
    if (!r || typeof r !== 'object') throw new SetupError('invalid_request');
    await updateScheduleRules(server().db, ctx, {
      backToBackSlots: r.backToBackSlots === true,
      slotStepMinutes: integer(r.slotStepMinutes),
      bufferMinutes: integer(r.bufferMinutes),
      minGapMinutes: integer(r.minGapMinutes),
      compactDays: r.compactDays === true,
      minNoticeMinutes: integer(r.minNoticeMinutes),
      maxAdvanceDays: integer(r.maxAdvanceDays),
      cancelDeadlineHours: integer(r.cancelDeadlineHours),
      firstLessonPrepaid: r.firstLessonPrepaid === true,
      defaultTrustedCreditLimit: integer(r.defaultTrustedCreditLimit),
    });
  });
}

export interface ServicePayload {
  slug: string;
  /** Brak: nowa usługa. */
  serviceId?: string;
  name: string;
  durationMinutes: number;
  creditCost: number;
  /** Cena pojedynczej lekcji w groszach; null = bez ceny. */
  priceCents: number | null;
  active?: boolean;
}

export async function saveServiceAction(input: ServicePayload): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    const fields = {
      name: text(input.name),
      durationMinutes: integer(input.durationMinutes),
      creditCost: integer(input.creditCost),
      priceCents: input.priceCents === null ? null : integer(input.priceCents),
    };
    if (input.serviceId === undefined) {
      await addService(server().db, ctx, fields);
    } else {
      await updateService(server().db, ctx, { ...fields, serviceId: uuid(input.serviceId), active: input.active !== false });
    }
  });
}

export interface PackagePayload {
  slug: string;
  /** Brak: nowy pakiet. */
  packageId?: string;
  name: string;
  credits: number;
  /** Cena w groszach. */
  priceCents: number;
  active?: boolean;
}

export async function savePackageAction(input: PackagePayload): Promise<SetupResult> {
  return attempt(input?.slug, async (ctx) => {
    const fields = { name: text(input.name), credits: integer(input.credits), priceCents: integer(input.priceCents) };
    if (input.packageId === undefined) {
      await addPackage(server().db, ctx, fields);
    } else {
      if (!UUID.test(text(input.packageId))) throw new SetupError('invalid_request');
      await updatePackage(server().db, ctx, { ...fields, packageId: text(input.packageId), active: input.active !== false });
    }
  });
}
