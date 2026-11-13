'use server';
// Zapis nowej pary ze strony zapisów szkoły. Para jest już zalogowana linkiem z maila;
// zasady pilnuje src/lib/registration.ts. Po zapisie para trafia prosto do kalendarza.
import { redirect } from 'next/navigation';
import { ClientError } from '../../../lib/clients';
import { findFirmBySlug, registerClient } from '../../../lib/registration';
import { server } from '../../../lib/server';
import { requireUser } from '../../../lib/session';

export interface SignUpPayload {
  slug: string;
  displayName: string;
  phone: string;
  targetDate: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export async function signUpAction(input: SignUpPayload): Promise<{ ok: false; error: string }> {
  const user = await requireUser();
  const firm = await findFirmBySlug(server().db, text(input?.slug));
  if (!firm) return { ok: false, error: 'Nie ma takiej szkoły. Sprawdźcie link do zapisów.' };
  try {
    await registerClient(
      server().db,
      { organizationId: firm.id, userId: user.id },
      { displayName: text(input.displayName), phone: text(input.phone), targetDate: text(input.targetDate) },
    );
  } catch (err) {
    if (err instanceof ClientError) return { ok: false, error: err.message };
    throw err;
  }
  // Poza try: redirect() przerywa akcję wyjątkiem, który obsługuje Next.js.
  redirect(`/panel/${firm.slug}?zapisano=1`);
}
