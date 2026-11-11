// Logowanie po stronie przeglądarki: prośba o link z maila.
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ plugins: [magicLinkClient()] });
