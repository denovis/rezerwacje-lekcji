// Adresy Better Auth: prośba o link (/api/auth/sign-in/magic-link), kliknięcie linku
// (/api/auth/magic-link/verify), sesja i wylogowanie.
import { server } from '../../../../lib/server';

export function GET(request: Request): Promise<Response> {
  return server().auth.handler(request);
}

export function POST(request: Request): Promise<Response> {
  return server().auth.handler(request);
}
