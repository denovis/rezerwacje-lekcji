// Ustawienia aplikacji: zabezpieczenia przed błędną konfiguracją.
import { describe, expect, it } from 'vitest';
import { readConfig } from './config';

const valid = {
  APP_DATABASE_URL: 'postgres://app_user:haslo@localhost:5433/rezerwacje',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
};

describe('Ustawienia aplikacji', () => {
  it('poprawne ustawienia są przyjmowane, a maile bez SMTP trafiają do logu', () => {
    const config = readConfig(valid);
    expect(config.appDatabaseUrl).toBe(valid.APP_DATABASE_URL);
    expect(config.smtpUrl).toBeUndefined();
  });

  it('aplikacja nie wystartuje, gdy łączy się z bazą innym kontem niż app_user', () => {
    expect(() =>
      readConfig({ ...valid, APP_DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/rezerwacje' }),
    ).toThrow('APP_DATABASE_URL musi używać konta app_user');
  });

  it('bez klucza Stripe płatności online są wyłączone', () => {
    expect(readConfig(valid)).toMatchObject({ stripeSecretKey: undefined, stripeWebhookSecret: undefined });
    const fake = { STRIPE_SECRET_KEY: `sk_test_${'x'.repeat(24)}`, STRIPE_WEBHOOK_SECRET: `whsec_${'y'.repeat(24)}` };
    expect(readConfig({ ...valid, ...fake })).toMatchObject({ stripeSecretKey: fake.STRIPE_SECRET_KEY });
  });

  it('lokalnie aplikacja nie wystartuje z produkcyjnym kluczem Stripe ani ze źle wklejonym kluczem', () => {
    expect(() => readConfig({ ...valid, STRIPE_SECRET_KEY: `sk_live_${'x'.repeat(24)}` })).toThrow('testowego klucza Stripe');
    expect(() => readConfig({ ...valid, STRIPE_SECRET_KEY: `pk_test_${'x'.repeat(24)}` })).toThrow('STRIPE_SECRET_KEY');
    expect(() => readConfig({ ...valid, STRIPE_WEBHOOK_SECRET: 'sekret' })).toThrow('whsec_');
    // Na serwerze z prawdziwym adresem klucz produkcyjny jest dozwolony.
    const live = { ...valid, BETTER_AUTH_URL: 'https://rezerwacje.example.com', STRIPE_SECRET_KEY: `sk_live_${'x'.repeat(24)}` };
    expect(readConfig(live).stripeSecretKey).toBe(live.STRIPE_SECRET_KEY);
  });

  it('aplikacja nie wystartuje bez klucza logowania albo z kluczem krótszym niż 32 znaki', () => {
    expect(() => readConfig({ ...valid, BETTER_AUTH_SECRET: undefined })).toThrow('BETTER_AUTH_SECRET');
    expect(() => readConfig({ ...valid, BETTER_AUTH_SECRET: 'za-krotki' })).toThrow('co najmniej 32 znaki');
  });
});
