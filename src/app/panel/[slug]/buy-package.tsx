'use client';
// Kupno pakietu lekcji online przez parę: okienko z pakietami, a po wyborze strona płatności Stripe
// (BLIK, karta, Przelewy24). Lekcje trafiają na konto po zapłacie.
import { useState } from 'react';
import type { WeekData } from '../../../lib/week-layout';
import { buyPackageAction } from './payment-actions';
import { Modal, useAction } from './ui';

export function BuyPackage({ slug, packages }: { slug: string; packages: WeekData['onlinePackages'] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link-button accent buy-package" onClick={() => setOpen(true)}>
        Kup pakiet lekcji
      </button>
      {open ? <BuyDialog slug={slug} packages={packages} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function BuyDialog({ slug, packages, onClose }: { slug: string; packages: WeekData['onlinePackages']; onClose: () => void }) {
  const { pending, error, run } = useAction();
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} pending={pending} error={error}>
      <h2>Kup pakiet lekcji</h2>
      <p className="muted small">Płacisz online: BLIK, karta albo Przelewy24. Lekcje trafią na konto zaraz po zapłacie.</p>
      <ul className="row-list">
        {packages.map((pkg) => (
          <li key={pkg.id}>
            <button
              type="button"
              className="row-button"
              disabled={pending}
              onClick={() => {
                setChosen(pkg.id);
                run(
                  () => buyPackageAction({ slug, packageId: pkg.id }),
                  (result) => {
                    if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
                  },
                );
              }}
            >
              <span>
                <strong>{pkg.name}</strong>
                <span className="muted small"> · {pkg.creditsLabel}</span>
              </span>
              <span>{pending && chosen === pkg.id ? 'Przechodzę do płatności…' : `Kup: ${pkg.priceLabel}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
